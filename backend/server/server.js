import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { JsonRpcProvider, Interface, getAddress, parseUnits } from "ethers";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
if (!BASE_SEPOLIA_RPC_URL) throw new Error("Missing BASE_SEPOLIA_RPC_URL in .env");

// Base Sepolia
const CHAIN = "eip155:84532";
const BASE_SEPOLIA_CHAIN_ID = 84532;

// USDC on Base Sepolia (testnet)
const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_DECIMALS = 6;
const TOKEN = "USDC";

// Vault payment configuration
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS;
const OWNER_ADDRESS = process.env.OWNER_ADDRESS;
const SPENDER_ADDRESS = process.env.SPENDER_ADDRESS || null;

if (!VAULT_ADDRESS) throw new Error("Missing VAULT_ADDRESS in .env");
if (!MERCHANT_ADDRESS) throw new Error("Missing MERCHANT_ADDRESS in .env");
if (!OWNER_ADDRESS) throw new Error("Missing OWNER_ADDRESS in .env");

const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC_URL);

// ExpenseVault event ABI (minimal)
const VAULT_IFACE = new Interface([
  "event Spent(address indexed owner,address indexed spender,address indexed merchant,uint256 amount,uint256 sharesBurned,uint256 dayIndex)",
]);

// In-memory invoices store (demo)
const invoices = {};

function nowMs() {
  return Date.now();
}

function msFromSeconds(sec) {
  return sec * 1000;
}

function makeId(prefix = "INV") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function clamp2(x) {
  return Math.round(Number(x) * 100) / 100;
}

function purchaseGasStation({ deviceId, payload }) {
  const stationId = payload?.station_id ?? deviceId ?? "station-777";
  const fuelType = payload?.fuel_type ?? "GASOLINE";
  const liters = Number(payload?.liters);
  const maxPrice = Number(payload?.max_price_per_liter_usd);

  if (!Number.isFinite(liters) || liters <= 0) throw new Error("Invalid liters");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error("Invalid max_price_per_liter_usd");

  const pricePerLiterUsd = Math.max(0.5, clamp2(maxPrice - 0.05));
  const totalUsd = clamp2(liters * pricePerLiterUsd);

  return { totalUsd, meta: { stationId, fuelType, liters, pricePerLiterUsd } };
}

function purchaseVending({ deviceId, payload }) {
  const sku = payload?.sku;
  const quantity = Number(payload?.quantity ?? 1);
  const maxUnit = Number(payload?.max_unit_price_usd);

  if (!sku) throw new Error("Invalid sku");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Invalid quantity");
  if (!Number.isFinite(maxUnit) || maxUnit <= 0) throw new Error("Invalid max_unit_price_usd");

  const unitPriceUsd = Math.max(0.5, clamp2(maxUnit - 0.05));
  const totalUsd = clamp2(unitPriceUsd * quantity);

  return { totalUsd, meta: { sku, quantity, unitPriceUsd, deviceId } };
}

function purchaseLaundry({ deviceId, payload }) {
  const program = payload?.program;
  const maxPrice = Number(payload?.max_price_usd);

  if (!program) throw new Error("Invalid program");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error("Invalid max_price_usd");

  const totalUsd = Math.max(1.0, clamp2(maxPrice - 0.1));
  return { totalUsd, meta: { program, deviceId } };
}

function createInvoiceForPurchase({ businessCase, deviceId, payload }) {
  if (businessCase === "gas_station") return purchaseGasStation({ deviceId, payload });
  if (businessCase === "vending_machine") return purchaseVending({ deviceId, payload });
  if (businessCase === "laundry") return purchaseLaundry({ deviceId, payload });
  throw new Error("Unsupported business_case");
}

function computeTotals(liters, pricePerLiterUsd) {
  const total = Number(liters) * Number(pricePerLiterUsd);
  return clamp2(total);
}

function normalizeTxHash(txHash) {
  if (typeof txHash !== "string") return null;
  let h = txHash.trim();
  if (!h.startsWith("0x")) h = "0x" + h;
  if (h.length !== 66) return null;
  return h;
}

function buildPaymentRequired(inv) {
  return {
    protocol: "x402",
    chain: inv.chain,
    token: inv.token,
    token_contract: inv.tokenContract,
    decimals: inv.tokenDecimals,

    // Amounts
    amount_usdc: inv.totalUsd, // human-friendly number (2 decimals)
    amount_base_units: inv.amountBaseUnits, // exact integer string (USDC 6 decimals)

    // Vault spend instructions
    vault_address: inv.vaultAddress,
    owner_address: inv.ownerAddress,
    merchant_address: inv.merchantAddress,
    spender_address: inv.spenderAddress, // may be null

    // Extra context (helps the client UI/agent)
    business_case: inv.businessCase,
    device_id: inv.deviceId,
    client_id: inv.clientId,

    invoice_id: inv.invoiceId,
    expires_at: new Date(inv.expiresAt).toISOString(),

    next_step:
      "Client Bot must send an on-chain tx calling " +
      "ExpenseVault.spend(owner_address, merchant_address, amount_base_units) " +
      "from the spender wallet. Then call POST /m2m/confirm with { invoiceId, txHash }.",
  };
}

async function verifyVaultSpendOnBaseSepolia(inv, txHash) {
  // 1) Basic txHash sanity (accept with/without 0x)
  const h = normalizeTxHash(txHash);
  if (!h) return { ok: false, reason: "Invalid txHash format" };

  // 2) Confirm network
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      ok: false,
      reason: `Wrong RPC network. Expected ${BASE_SEPOLIA_CHAIN_ID}, got ${net.chainId}`,
    };
  }

  // 3) Get receipt
  const receipt = await provider.getTransactionReceipt(h);
  if (!receipt) return { ok: false, reason: "Transaction not found yet (no receipt)" };
  if (receipt.status !== 1) return { ok: false, reason: "Transaction failed (status != 1)" };

  const vaultAddr = getAddress(inv.vaultAddress);
  const expectedOwner = getAddress(inv.ownerAddress);
  const expectedMerchant = getAddress(inv.merchantAddress);
  const expectedAmount = BigInt(inv.amountBaseUnits);

  // Optional: enforce spender sender
  if (inv.spenderAddress) {
    if (getAddress(receipt.from) !== getAddress(inv.spenderAddress)) {
      return { ok: false, reason: "Tx sender is not the configured spender" };
    }
  }

  // Optional: ensure tx was sent to the vault contract
  if (receipt.to && getAddress(receipt.to) !== vaultAddr) {
    return { ok: false, reason: "Tx was not sent to the Vault contract" };
  }

  // 4) Scan logs for matching Spent(owner, spender, merchant, amount, ...)
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== vaultAddr) continue;

    try {
      const parsed = VAULT_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (!parsed || parsed.name !== "Spent") continue;

      const owner = getAddress(parsed.args.owner);
      const spender = getAddress(parsed.args.spender);
      const merchant = getAddress(parsed.args.merchant);
      const amount = BigInt(parsed.args.amount.toString());

      const spenderOk = !inv.spenderAddress || spender === getAddress(inv.spenderAddress);

      if (owner === expectedOwner && merchant === expectedMerchant && amount === expectedAmount && spenderOk) {
        return { ok: true, normalizedTxHash: h };
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return { ok: false, reason: "No matching Spent event found in receipt logs" };
}

function makeInvoiceBase({
  businessCase,
  deviceId,
  clientId,
  totalUsd,
  meta = {},
}) {
  const invoiceId = makeId("INV");
  const ttlSeconds = 120; // 2 minutes for demo
  const createdAt = nowMs();
  const expiresAt = createdAt + msFromSeconds(ttlSeconds);

  // exact USDC amount (6 decimals) as string
  const amountBaseUnits = parseUnits(String(totalUsd), USDC_DECIMALS).toString();

  const inv = {
    invoiceId,
    createdAt,
    expiresAt,

    businessCase,
    deviceId,
    clientId,

    totalUsd,

    chain: CHAIN,
    token: TOKEN,
    tokenContract: USDC_CONTRACT,
    tokenDecimals: USDC_DECIMALS,
    amountBaseUnits,

    // Vault payment metadata
    vaultAddress: VAULT_ADDRESS,
    ownerAddress: OWNER_ADDRESS,
    merchantAddress: MERCHANT_ADDRESS,
    spenderAddress: SPENDER_ADDRESS,

    status: "PENDING",
    meta,
  };

  invoices[invoiceId] = inv;
  return inv;
}

function buildPaidResponse(inv) {
  return {
    ok: true,
    event: "SERVICE_UNLOCKED",
    invoiceId: inv.invoiceId,
    business_case: inv.businessCase,
    device_id: inv.deviceId,
    client_id: inv.clientId,
    totalUsd: inv.totalUsd,
    token: inv.token,
    message: "Vault spend verified on-chain. Device unlocked (simulated).",
    meta: inv.meta || {},
  };
}

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "m2m-payments-server",
    chain: CHAIN,
    token: TOKEN,
    time: new Date().toISOString(),
    vault: VAULT_ADDRESS,
    merchant: MERCHANT_ADDRESS,
    owner: OWNER_ADDRESS,
    spender: SPENDER_ADDRESS,
  });
});

// --------------------
// Universal confirm
// POST /m2m/confirm
// Body: { invoiceId, txHash }
// --------------------
app.post("/m2m/confirm", async (req, res) => {
  const { invoiceId, txHash } = req.body || {};

  if (!invoiceId || typeof invoiceId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing invoiceId" });
  }
  if (!txHash || typeof txHash !== "string") {
    return res.status(400).json({ ok: false, error: "Missing txHash" });
  }

  const inv = invoices[invoiceId];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status === "EXPIRED" || nowMs() > inv.expiresAt) {
    inv.status = "EXPIRED";
    return res.status(402).json({ ok: false, error: "Invoice expired", invoiceId: inv.invoiceId });
  }

  const result = await verifyVaultSpendOnBaseSepolia(inv, txHash);

  if (!result.ok) {
    return res.status(402).json({
      ok: false,
      error: "PAYMENT_NOT_VERIFIED_YET",
      reason: result.reason,
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  }

  inv.status = "PAID";
  inv.txHash = result.normalizedTxHash || normalizeTxHash(txHash) || txHash;

  return res.status(200).json(buildPaidResponse(inv));
});

// Backwards-compatible alias: /fuel/confirm -> same as /m2m/confirm
app.post("/fuel/confirm", async (req, res) => {
  // Reuse the same handler by calling logic directly
  const { invoiceId, txHash } = req.body || {};
  if (!invoiceId || !txHash) {
    return res.status(400).json({ ok: false, error: "Missing invoiceId or txHash" });
  }

  const inv = invoices[invoiceId];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status === "EXPIRED" || nowMs() > inv.expiresAt) {
    inv.status = "EXPIRED";
    return res.status(402).json({ ok: false, error: "Invoice expired", invoiceId: inv.invoiceId });
  }

  const result = await verifyVaultSpendOnBaseSepolia(inv, txHash);

  if (!result.ok) {
    return res.status(402).json({
      ok: false,
      error: "PAYMENT_NOT_VERIFIED_YET",
      reason: result.reason,
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  }

  inv.status = "PAID";
  inv.txHash = result.normalizedTxHash || normalizeTxHash(txHash) || txHash;

  // Keep old response shape for fuel clients:
  if (inv.businessCase === "gas_station") {
    return res.status(200).json({
      ok: true,
      event: "FUEL_PURCHASE_CONFIRMED",
      invoiceId: inv.invoiceId,
      stationId: inv.meta?.stationId,
      carId: inv.clientId,
      fuelType: inv.meta?.fuelType,
      liters: inv.meta?.liters,
      pricePerLiterUsd: inv.meta?.pricePerLiterUsd,
      totalUsd: inv.totalUsd,
      message: "Vault spend verified on-chain. Fuel pump unlocked (simulated).",
    });
  }

  // Otherwise return generic
  return res.status(200).json(buildPaidResponse(inv));
});

// --------------------
// POST /m2m/purchase (unified)
// Body:
// {
//   business_case: "gas_station"|"vending_machine"|"laundry",
//   client_id: "client-001",
//   device_id: "xxx-123",
//   payload: {...}
// }
// Always returns 402 with vault payment instructions.
// --------------------
app.post("/m2m/purchase", async (req, res) => {
  const {
    business_case: businessCase,
    client_id: clientId = "client-001",
    device_id: deviceId = "device-unknown",
    payload = {},
  } = req.body || {};

  if (!businessCase || typeof businessCase !== "string") {
    return res.status(400).json({ ok: false, error: "Missing business_case" });
  }

  try {
    if (businessCase === "gas_station") {
      const {
        station_id: stationId = "station-777",
        fuel_type: fuelType = "GASOLINE",
        liters,
        max_price_per_liter_usd: maxPrice,
      } = payload || {};

      if (typeof liters !== "number" || liters <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid liters" });
      }
      if (typeof maxPrice !== "number" || maxPrice <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid max_price_per_liter_usd" });
      }

      // Demo pricing: slightly cheaper than max
      const pricePerLiterUsd = Math.max(0.5, clamp2(maxPrice - 0.05));
      const totalUsd = computeTotals(liters, pricePerLiterUsd);

      const inv = makeInvoiceBase({
        businessCase,
        deviceId,
        clientId,
        totalUsd,
        meta: { stationId, fuelType, liters, pricePerLiterUsd },
      });

      return res.status(402).json({
        ok: false,
        error: "PAYMENT_REQUIRED",
        invoiceId: inv.invoiceId,
        payment_required: buildPaymentRequired(inv),
      });
    }

    if (businessCase === "vending_machine") {
      const { sku, quantity, max_unit_price_usd: maxUnit } = payload || {};

      if (!sku) return res.status(400).json({ ok: false, error: "Invalid sku" });

      const qty = Number(quantity ?? 1);
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ ok: false, error: "Invalid quantity" });

      const max = Number(maxUnit);
      if (!Number.isFinite(max) || max <= 0) return res.status(400).json({ ok: false, error: "Invalid max_unit_price_usd" });

      const unitPriceUsd = Math.max(0.5, clamp2(max - 0.05));
      const totalUsd = clamp2(unitPriceUsd * qty);

      const inv = makeInvoiceBase({
        businessCase,
        deviceId,
        clientId,
        totalUsd,
        meta: { sku, quantity: qty, unitPriceUsd },
      });

      return res.status(402).json({
        ok: false,
        error: "PAYMENT_REQUIRED",
        invoiceId: inv.invoiceId,
        payment_required: buildPaymentRequired(inv),
      });
    }

    if (businessCase === "laundry") {
      const { program, max_price_usd: maxPrice } = payload || {};
      if (!program) return res.status(400).json({ ok: false, error: "Invalid program" });

      const max = Number(maxPrice);
      if (!Number.isFinite(max) || max <= 0) return res.status(400).json({ ok: false, error: "Invalid max_price_usd" });

      const totalUsd = Math.max(1.0, clamp2(max - 0.1));

      const inv = makeInvoiceBase({
        businessCase,
        deviceId,
        clientId,
        totalUsd,
        meta: { program },
      });

      return res.status(402).json({
        ok: false,
        error: "PAYMENT_REQUIRED",
        invoiceId: inv.invoiceId,
        payment_required: buildPaymentRequired(inv),
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Unsupported business_case",
      supported: ["gas_station", "vending_machine", "laundry"],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Internal error", detail: String(e) });
  }
});

// --------------------
// Backwards compatible endpoints
// --------------------

// POST /fuel/purchase (existing clients)
// Always returns 402 with vault payment instructions.
app.post("/fuel/purchase", async (req, res) => {
  const {
    car_id: carId = "car-001",
    station_id: stationId = "station-777",
    fuel_type: fuelType = "GASOLINE",
    liters,
    max_price_per_liter_usd: maxPrice,
  } = req.body || {};

  if (typeof liters !== "number" || liters <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid liters" });
  }
  if (typeof maxPrice !== "number" || maxPrice <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid max_price_per_liter_usd" });
  }

  const pricePerLiterUsd = Math.max(0.5, clamp2(maxPrice - 0.05));
  const totalUsd = computeTotals(liters, pricePerLiterUsd);

  const inv = makeInvoiceBase({
    businessCase: "gas_station",
    deviceId: stationId,
    clientId: carId,
    totalUsd,
    meta: { stationId, fuelType, liters, pricePerLiterUsd },
  });

  return res.status(402).json({
    ok: false,
    error: "PAYMENT_REQUIRED",
    invoiceId: inv.invoiceId,
    payment_required: buildPaymentRequired(inv),
  });
});

// vending purchase 
app.post("/vending/purchase", async (req, res) => {
  const clientId = req.body?.client_id ?? "client-001";
  const deviceId = req.body?.device_id ?? "vending-unknown";
  const payload = req.body?.payload ?? {};

  try {
    const { totalUsd, meta } = createInvoiceForPurchase({
      businessCase: "vending_machine",
      clientId,
      deviceId,
      payload,
    });

    const inv = makeInvoiceBase({
      businessCase: "vending_machine",
      deviceId,
      clientId,
      totalUsd,
      meta,
    });

    return res.status(402).json({
      ok: false,
      error: "PAYMENT_REQUIRED",
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// laundry purchase 
app.post("/laundry/purchase", async (req, res) => {
  const clientId = req.body?.client_id ?? "client-001";
  const deviceId = req.body?.device_id ?? "laundry-unknown";
  const payload = req.body?.payload ?? {};

  try {
    const { totalUsd, meta } = createInvoiceForPurchase({
      businessCase: "laundry",
      clientId,
      deviceId,
      payload,
    });

    const inv = makeInvoiceBase({
      businessCase: "laundry",
      deviceId,
      clientId,
      totalUsd,
      meta,
    });

    return res.status(402).json({
      ok: false,
      error: "PAYMENT_REQUIRED",
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// GET invoice debug (unified)
// --------------------
app.get("/m2m/invoice/:id", (req, res) => {
  const { id } = req.params;
  const inv = invoices[id];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status !== "PAID" && nowMs() > inv.expiresAt) inv.status = "EXPIRED";

  res.json({ ok: true, invoice: inv, payment_required: buildPaymentRequired(inv) });
});

// Keep old debug endpoint too
app.get("/fuel/invoice/:id", (req, res) => {
  const { id } = req.params;
  const inv = invoices[id];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status !== "PAID" && nowMs() > inv.expiresAt) inv.status = "EXPIRED";

  res.json({ ok: true, invoice: inv, payment_required: buildPaymentRequired(inv) });
});

// --------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});



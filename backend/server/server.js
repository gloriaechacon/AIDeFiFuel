import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import { HDNodeWallet,JsonRpcProvider, Interface, getAddress, parseUnits } from "ethers";

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

const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC_URL);

// Minimal ERC-20 Transfer ABI
const ERC20_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const STATION_MNEMONIC = process.env.STATION_MNEMONIC;
const STATE_PATH = process.env.STATION_STATE_PATH || "./station_state.json";
const START_INDEX = Number(process.env.STATION_DERIVATION_START || 0);


if (!STATION_MNEMONIC) {
  throw new Error("Missing STATION_MNEMONIC in .env");
}



function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { nextIndex: START_INDEX };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Derive a unique pay-to address for each invoice
function allocatePayToAddress() {
  const state = loadState();
  const i = Number(state.nextIndex ?? START_INDEX);

  // Standard Ethereum derivation path
  const path = `m/44'/60'/0'/0/${i}`;

  const wallet = HDNodeWallet.fromPhrase(STATION_MNEMONIC, undefined, path);
  const address = wallet.address;

  state.nextIndex = i + 1;
  saveState(state);

  return { address, derivationPath: path, index: i };
}

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

function computeTotals(liters, pricePerLiterUsd) {
  const total = Number(liters) * Number(pricePerLiterUsd);
  // keep 2 decimals for UX
  return Math.round(total * 100) / 100;
}

// For hackathon stub: a fixed address is OK,
// but x402 is better with unique addresses per invoice (later).
const STATION_PAY_TO_ADDRESS =
  process.env.STATION_PAY_TO_ADDRESS || "0x0000000000000000000000000000000000000000";

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "aidfi-fuel-server",
    chain: CHAIN,
    token: TOKEN,
    time: new Date().toISOString(),
  });
});

// --------------------
// POST /fuel/purchase
// This is your x402 "protected" endpoint.
// If not paid yet -> respond 402 with payment requirements.
// If paid -> return success.
// --------------------
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

  // Simple pricing policy: try to be <= maxPrice, but not always.
  // For demo: choose a price close to max, but slightly cheaper.
  const pricePerLiterUsd = Math.max(0.5, Math.round((maxPrice - 0.05) * 100) / 100);
  const totalUsd = computeTotals(liters, pricePerLiterUsd);

  // Client can send proof header later.
  // For now we use a simple header: x-invoice-id + x-payment-proof
  // In x402 real flow, you'd use the x402 headers/payload.
  const invoiceIdHeader = req.header("x-invoice-id");
  const paymentProof = req.header("x-payment-proof");

  // If they provided invoiceId + proof, we try to validate it (stub)
  if (invoiceIdHeader) {
    const inv = invoices[invoiceIdHeader];
    if (!inv) {
      return res.status(404).json({ ok: false, error: "Invoice not found" });
    }
    if (inv.status === "EXPIRED" || nowMs() > inv.expiresAt) {
      inv.status = "EXPIRED";
      return res.status(402).json({ ok: false, error: "Invoice expired", invoiceId: inv.invoiceId });
    }

    // STUB verification: any non-empty paymentProof marks as paid
    // Later: verify on-chain USDC transfer to inv.payToAddress
    const txHash = req.header("x-tx-hash");

  if (txHash) {
    const result = await verifyUsdcPaymentOnBaseSepolia(inv, txHash);

    if (result.ok) {
      inv.status = "PAID";
      inv.txHash = txHash;

      return res.status(200).json({
        ok: true,
        event: "FUEL_PURCHASE_CONFIRMED",
        invoiceId: inv.invoiceId,
        stationId: inv.stationId,
        carId: inv.carId,
        fuelType: inv.fuelType,
        liters: inv.liters,
        pricePerLiterUsd: inv.pricePerLiterUsd,
        totalUsd: inv.totalUsd,
        message: "Payment verified on-chain. Fuel pump unlocked (simulated).",
      });
    }

    return res.status(402).json({
      ok: false,
      error: "PAYMENT_NOT_VERIFIED_YET",
      reason: result.reason,
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  }

    // If invoice exists but no proof, ask for payment again
    return res.status(402).json({
      ok: false,
      error: "PAYMENT_REQUIRED",
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  }

  // Create a NEW invoice
  const invoiceId = makeId("INV");
  const ttlSeconds = 120; // 2 minutes for demo
  const createdAt = nowMs();
  const expiresAt = createdAt + msFromSeconds(ttlSeconds);
  const amountBaseUnits = parseUnits(String(totalUsd), USDC_DECIMALS).toString();

  const allocation = allocatePayToAddress();

  const inv = {
    invoiceId,
    createdAt,
    expiresAt,
    carId,
    stationId,
    fuelType,
    liters,
    pricePerLiterUsd,
    totalUsd,
    chain: CHAIN,
    token: TOKEN,    
    tokenContract: USDC_CONTRACT,
    tokenDecimals: USDC_DECIMALS,    
    amountBaseUnits,
    payToAddress: allocation.address,
    payToIndex: allocation.index,
    payToDerivationPath: allocation.derivationPath,
    status: "PENDING",
  };

  invoices[invoiceId] = inv;

  // Respond as x402-style: HTTP 402 with payment instructions
  return res.status(402).json({
    ok: false,
    error: "PAYMENT_REQUIRED",
    invoiceId,
    payment_required: buildPaymentRequired(inv),
  });
});

function buildPaymentRequired(inv) {
  return {
    protocol: "x402",
    chain: inv.chain,
    token: inv.token,
    token_contract: inv.tokenContract,
    decimals: inv.tokenDecimals,
    amount_usdc: inv.totalUsd,              // human-readable
    amount_base_units: inv.amountBaseUnits, // exact on-chain value
    pay_to_address: inv.payToAddress,
    invoice_id: inv.invoiceId,
    expires_at: new Date(inv.expiresAt).toISOString(),
    next_step:
      `Send exactly ${inv.totalUsd} ${inv.token} on ${inv.chain} to ${inv.payToAddress}. ` +
      `Then retry POST /fuel/purchase with headers: x-invoice-id and x-tx-hash.`,
  };
}

// --------------------
// GET /fuel/invoice/:id
// --------------------
app.get("/fuel/invoice/:id", (req, res) => {
  const { id } = req.params;
  const inv = invoices[id];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  // expire on read if needed
  if (inv.status !== "PAID" && nowMs() > inv.expiresAt) inv.status = "EXPIRED";

  res.json({ ok: true, invoice: inv, payment_required: buildPaymentRequired(inv) });
});

// --------------------
// POST /fuel/receipt
// In a real flow, you'd only allow this if invoice is PAID.
// Here we keep it simple.
// --------------------
app.post("/fuel/receipt", (req, res) => {
  const { invoiceId } = req.body || {};
  const inv = invoices[invoiceId];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });
  if (inv.status !== "PAID") return res.status(409).json({ ok: false, error: "Invoice not paid" });

  return res.json({
    ok: true,
    event: "RECEIPT_ISSUED",
    invoiceId: inv.invoiceId,
    carId: inv.carId,
    stationId: inv.stationId,
    totalUsd: inv.totalUsd,
    token: inv.token,
    issuedAt: new Date().toISOString(),
  });
});

async function verifyUsdcPaymentOnBaseSepolia(inv, txHash) {
  // 1) Basic txHash sanity
  if (typeof txHash !== "string" || !txHash.startsWith("0x") || txHash.length !== 66) {
    return { ok: false, reason: "Invalid txHash format" };
  }

  // 2) Confirm network (optional but helpful)
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    return { ok: false, reason: `Wrong RPC network. Expected ${BASE_SEPOLIA_CHAIN_ID}, got ${net.chainId}` };
  }

  // 3) Get receipt
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    return { ok: false, reason: "Transaction not found yet (no receipt)" };
  }
  if (receipt.status !== 1) {
    return { ok: false, reason: "Transaction failed (status != 1)" };
  }

  const expectedTo = getAddress(inv.payToAddress);
  const expectedValue = BigInt(inv.amountBaseUnits);
  const usdcAddr = getAddress(inv.tokenContract);

  // 4) Scan logs for USDC Transfer(to=payToAddress, value=amountBaseUnits)
  for (const log of receipt.logs) {
    // log.address must be USDC contract
    if (getAddress(log.address) !== usdcAddr) continue;

    // Try to parse as ERC-20 Transfer
    try {
      const parsed = ERC20_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (!parsed || parsed.name !== "Transfer") continue;

      const to = getAddress(parsed.args.to);
      const value = BigInt(parsed.args.value.toString());

      if (to === expectedTo && value === expectedValue) {
        return { ok: true };
      }
    } catch {
      // Not a Transfer log, ignore
    }
  }

  return { ok: false, reason: "No matching USDC Transfer found in receipt logs" };
}

// --------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

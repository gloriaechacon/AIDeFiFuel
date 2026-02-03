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

function buildPaymentRequired(inv) {
  return {
    protocol: "x402",
    chain: inv.chain,
    token: inv.token,
    token_contract: inv.tokenContract,
    decimals: inv.tokenDecimals,

    // Amounts
    amount_usdc: inv.totalUsd,                 // human-friendly number (2 decimals)
    amount_base_units: inv.amountBaseUnits,    // exact integer string (USDC 6 decimals)

    // Vault spend instructions
    vault_address: inv.vaultAddress,
    owner_address: inv.ownerAddress,
    merchant_address: inv.merchantAddress,
    spender_address: inv.spenderAddress,       // may be null

    invoice_id: inv.invoiceId,
    expires_at: new Date(inv.expiresAt).toISOString(),

    next_step:
      "Car Agent must send an on-chain tx calling " +
      "ExpenseVault.spend(owner_address, merchant_address, amount_base_units) " +
      "from the spender wallet. Then call POST /fuel/confirm with { invoiceId, txHash }.",
  };
}

async function verifyVaultSpendOnBaseSepolia(inv, txHash) {
  // 1) Basic txHash sanity
  if (typeof txHash !== "string" || !txHash.startsWith("0x") || txHash.length !== 66) {
    return { ok: false, reason: "Invalid txHash format" };
  }

  // 2) Confirm network
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      ok: false,
      reason: `Wrong RPC network. Expected ${BASE_SEPOLIA_CHAIN_ID}, got ${net.chainId}`,
    };
  }

  // 3) Get receipt
  const receipt = await provider.getTransactionReceipt(txHash);
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
        return { ok: true };
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return { ok: false, reason: "No matching Spent event found in receipt logs" };
}

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
    vault: VAULT_ADDRESS,
    merchant: MERCHANT_ADDRESS,
    owner: OWNER_ADDRESS,
    spender: SPENDER_ADDRESS,
  });
});

// --------------------
// POST /fuel/purchase
// Always returns 402 with vault payment instructions.
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

  // Demo pricing: slightly cheaper than max
  const pricePerLiterUsd = Math.max(0.5, Math.round((maxPrice - 0.05) * 100) / 100);
  const totalUsd = computeTotals(liters, pricePerLiterUsd);

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

    // Vault payment metadata
    vaultAddress: VAULT_ADDRESS,
    ownerAddress: OWNER_ADDRESS,
    merchantAddress: MERCHANT_ADDRESS,
    spenderAddress: SPENDER_ADDRESS,

    status: "PENDING",
  };

  invoices[invoiceId] = inv;

  return res.status(402).json({
    ok: false,
    error: "PAYMENT_REQUIRED",
    invoiceId,
    payment_required: buildPaymentRequired(inv),
  });
});

// --------------------
// POST /fuel/confirm
// Car Agent sends { invoiceId, txHash } after calling vault.spend()
// --------------------
app.post("/fuel/confirm", async (req, res) => {
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
    message: "Vault spend verified on-chain. Fuel pump unlocked (simulated).",
  });
});

// --------------------
// GET /fuel/invoice/:id (useful for debugging)
// --------------------
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


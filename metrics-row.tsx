"use client";

import styles from "./metrics-row.module.css";
import { MetricsCard } from "./metrics-card";
import { useSimulation } from "../simulation/simulation-context";

function fmtUsdc(n?: number) {
  if (typeof n !== "number") return "—";
  return `${n.toFixed(2)} USDC`;
}

function timeAgo(ts?: number) {
  if (!ts) return "—";
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

export function MetricsRow() {
  const { state } = useSimulation();
  const stats = state.dashboardStats;

  return (
    <section className={styles.row}>
      <MetricsCard
        title="Expense Vault Balance"
        value={fmtUsdc(stats.expenseVaultBalanceUsdc)}
        icon={<span>💳</span>}
      />

      <MetricsCard
        title="Yield Earned"
        value={fmtUsdc(stats.yieldEarnedUsdc)}
        sub="fees generated while idle"
        icon={<span>📈</span>}
      />

      <MetricsCard
        title="Last Payment"
        value={typeof stats.lastPaymentAmountUsdc === "number" ? `$${stats.lastPaymentAmountUsdc.toFixed(2)}` : "—"}
        sub={typeof stats.lastPaymentTimestamp === "number" ? timeAgo(stats.lastPaymentTimestamp) : "—"}
        icon={<span>🧾</span>}
      />
    </section>
  );
}
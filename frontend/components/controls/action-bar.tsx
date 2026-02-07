"use client";

import styles from "./action-bar.module.css";
import { Button } from "./button";
import { useSimulation } from "../simulation/simulation-context";
import { VaultModal } from "@/components/vault/vault-modal";
import { useMemo, useState } from "react";
import { createWagmiVaultAdapter } from "@/components/vault/vault-adapter-wagmi";

export function ActionBar() {
  const { start, reset, state } = useSimulation();
  const isLocal = state.mode === "local";
  const noBusinessCase = !state.selectedBusinessCase;
  const isTestnet = state.mode === "testnet";
  const [fundOpen, setFundOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  async function handleStartSession() {
    start();
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001";
    try {
      const resp = await fetch(`${serverUrl}/agents/m2m/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_case: state.selectedBusinessCase }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error("Start Session failed:", resp.status, text);
      }
    } catch (err) {
      console.error("Start Session error:", err);
    }
  }

  const vaultAdapter = useMemo(() => {
    return isTestnet ? createWagmiVaultAdapter() : null;
  }, [isTestnet]);

  return (
    <section className={styles.bar}>
      <div className={styles.left}>
        <Button onClick={handleStartSession} disabled={state.isRunning || noBusinessCase}>
          Start Session
        </Button>
        {!isLocal && (
          <Button variant="secondary" onClick={reset}>Reset</Button>
        )}
      </div>

      <div className={styles.right}>
        <Button variant="secondary" disabled={isLocal} onClick={() => setFundOpen(true)}>
          Fund Vault
        </Button>
        <Button variant="secondary" disabled={isLocal} onClick={() => setWithdrawOpen(true)}>
          Withdraw Vault
        </Button>
      </div>

      <VaultModal
        open={fundOpen}
        title="Fund Expense Vault"
        modeLabel="Fund"
        onClose={() => setFundOpen(false)}
        onConfirm={isTestnet ? vaultAdapter!.fund : undefined}
      />

      <VaultModal
        open={withdrawOpen}
        title="Withdraw from Expense Vault"
        modeLabel="Withdraw"
        onClose={() => setWithdrawOpen(false)}
        onConfirm={isTestnet ? vaultAdapter!.withdraw : undefined}
      />
    </section>
  );
}

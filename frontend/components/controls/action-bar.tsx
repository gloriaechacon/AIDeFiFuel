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
  const isTestnet = state.mode === "testnet";
  const [fundOpen, setFundOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const vaultAdapter = useMemo(() => {
    return isTestnet ? createWagmiVaultAdapter() : null;
  }, [isTestnet]);

  return (
    <section className={styles.bar}>
      <div className={styles.left}>
        <Button onClick={start} disabled={state.isRunning}>Start Session</Button>
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
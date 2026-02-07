import { writeContract, waitForTransactionReceipt } from "@wagmi/core";
import { parseUnits } from "viem";
import { wagmiConfig } from "../../wallet/wagmi";
import { EXPENSE_VAULT_ABI, EXPENSE_VAULT_ADDRESS } from "../lib/contracts/expense-vault";
import type { VaultAdapter } from "./vault-adapter";

const USDC_DECIMALS = 6;

function toUsdcUnits(amountUsdc: string) {
  return parseUnits(amountUsdc, USDC_DECIMALS);
}

export function createWagmiVaultAdapter(): VaultAdapter {
  return {
    async fund(amountUsdc: string) {
      const amount = toUsdcUnits(amountUsdc);

      const hash = await writeContract(wagmiConfig, {
        address: EXPENSE_VAULT_ADDRESS,
        abi: EXPENSE_VAULT_ABI,
        functionName: "deposit",
        args: [amount],
      });

      await waitForTransactionReceipt(wagmiConfig, { hash });
    },

    async withdraw(amountUsdc: string) {
      const amount = toUsdcUnits(amountUsdc);

      const hash = await writeContract(wagmiConfig, {
        address: EXPENSE_VAULT_ADDRESS,
        abi: EXPENSE_VAULT_ABI,
        functionName: "withdraw",
        args: [amount],
      });

      await waitForTransactionReceipt(wagmiConfig, { hash });
    },
  };
}
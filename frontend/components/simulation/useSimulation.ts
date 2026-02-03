//WIP MOCK useSimulation.ts

import { useCallback, useState } from "react";
import { SimulationState, SimulationMode, TimelineEvent } from "./types";

const initialState: SimulationState = {
  mode: "local",
  isRunning: false,
  flowState: "NEED_FUEL",
  flowStartedAt: undefined,
  timeline: [],
  dashboardStats: {
    vaultBalanceUsdc: 125.4,
    yieldEarnedUsdc: 0.38,
    paymentGateStatus: "None",
    lastRefuelTimestamp: undefined,
    lastRefuelAmountUsdc: undefined,
  },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now());
}

function addEvent(
  prev: TimelineEvent[],
  ev: Omit<TimelineEvent, "id" | "timestamp">
): TimelineEvent[] {
  return [
    ...prev,
    {
      id: safeId(),
      timestamp: Date.now(),
      ...ev,
    },
  ];
}

export function useSimulation() {
  const [state, setState] = useState<SimulationState>(initialState);

  const setMode = useCallback((mode: SimulationMode) => {
    setState((s) => ({ ...s, mode }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({
      ...initialState,
      mode: s.mode,
    }));
  }, []);

  const start = useCallback(async () => {
    setState((s) => ({
      ...s,
      isRunning: true,
      flowStartedAt: Date.now(),
      flowState: "NEED_FUEL",
      timeline: [],
      dashboardStats: { ...s.dashboardStats, paymentGateStatus: "None" },
    }));

    setState((s) => ({
      ...s,
      timeline: addEvent(s.timeline, {
        type: "QUOTE_REQUESTED",
        title: "Quote Requested",
        description: "Car agent requested a fuel quote",
        status: "info",
      }),
    }));

    await wait(500);

    setState((s) => ({
      ...s,
      flowState: "WAITING_PAYMENT",
      timeline: addEvent(s.timeline, {
        type: "PAYMENT_REQUIRED_402",
        title: "402 Payment Required",
        description: "Gas station enforced 0x402 payment gate",
        status: "warning",
        meta: { Gate: "0x402" },
      }),
    }));

    await wait(700);

    setState((s) => ({
      ...s,
      flowState: "COMPLETED",
      isRunning: false,
      dashboardStats: {
        ...s.dashboardStats,
        paymentGateStatus: "Verified",
        lastRefuelAmountUsdc: 12,
        lastRefuelTimestamp: Date.now(),
        vaultBalanceUsdc: +(s.dashboardStats.vaultBalanceUsdc - 12).toFixed(2),
      },
      timeline: addEvent(
        addEvent(s.timeline, {
          type: "PAYMENT_VERIFIED",
          title: "Payment Verified",
          description: "Payment confirmed; access authorized",
          status: "success",
        }),
        {
          type: "REFUEL_COMPLETED",
          title: "Refuel Completed",
          description: "Autonomous refuel finished successfully",
          status: "success",
        }
      ),
    }));
  }, []);

  const sessionDurationSec =
    state.flowStartedAt ? Math.floor((Date.now() - state.flowStartedAt) / 1000) : 0;

  return {
    state,
    setMode,
    start,
    reset,
    sessionDurationSec,
  };
}

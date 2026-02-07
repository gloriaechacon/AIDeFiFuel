"use client";

import React, { createContext, useContext, useCallback, useMemo, useState, useEffect, useRef } from "react";
import type { SimulationMode, SimulationState, TimelineEvent, BusinessCase } from "./types";

const initialState: SimulationState = {
  mode: "testnet",
  isRunning: false,
  flowState: "NEED_ACCESS",
  flowStartedAt: undefined,
  timeline: [],
  dashboardStats: {
    expenseVaultBalanceUsdc: 0,
    yieldEarnedUsdc: 0,
    paymentGateStatus: "None",
    lastPaymentTimestamp: undefined,
    lastPaymentAmountUsdc: undefined,
  },
  selectedBusinessCase: null,
};

function safeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
}

function addEvent(prev: TimelineEvent[], ev: Omit<TimelineEvent, "id" | "timestamp">): TimelineEvent[] {
  return [...prev, { id: safeId(), timestamp: Date.now(), ...ev }];
}

type SimulationContextValue = {
  state: SimulationState;
  setMode: (mode: SimulationMode) => void;
  setBusinessCase: (businessCase: BusinessCase | null) => void;
  start: () => Promise<void>;
  abort: (reason?: string) => void;
  reset: () => void;
  sessionDurationSec: number;
};

const SimulationContext = createContext<SimulationContextValue | null>(null);

export function SimulationProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SimulationState>(initialState);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001";

    async function fetchTimeline() {
      const resp = await fetch(`${serverUrl}/ui/timeline?limit=100`);
      if (!resp.ok) throw new Error(`timeline fetch failed: ${resp.status}`);
      const data = await resp.json();
      return Array.isArray(data.items) ? data.items : [];
    }

    async function poll() {
      try {
        const timeline = await fetchTimeline();

        setState((s) => {
          const lastPaymentEvent = timeline.find((e: TimelineEvent) =>
            e.type === "ACCESS_GRANTED" || e.type === "PAYMENT_VERIFIED"
          );

          const latest = timeline[timeline.length - 1];
          const flowState =
            latest?.type === "PAYMENT_REQUIRED_402"
              ? "AWAITING_AUTHORIZATION"
              : latest?.type === "PAYMENT_VERIFIED" || latest?.type === "ACCESS_GRANTED"
                ? "AUTHORIZATION_CONFIRMED"
                : latest?.type === "SERVICE_FULFILLED"
                  ? "COMPLETED"
                  : latest?.type === "FLOW_ABORTED" || latest?.type === "ERROR"
                    ? "ABORTED"
                    : latest?.type === "QUOTE_REQUESTED"
                      ? "NEED_ACCESS"
                      : s.flowState;

          const paymentGateStatus =
            timeline.some((e: TimelineEvent) => e.type === "PAYMENT_VERIFIED" || e.type === "ACCESS_GRANTED")
              ? "Verified"
              : timeline.some((e: TimelineEvent) => e.type === "PAYMENT_REQUIRED_402")
                ? "Pending"
                : "None";

          const shouldStop =
            timeline.some((e: TimelineEvent) =>
              ["ACCESS_GRANTED", "SERVICE_FULFILLED", "FLOW_ABORTED", "ERROR"].includes(e.type)
            );

          return {
            ...s,
            isRunning: shouldStop ? false : s.isRunning,
            flowState,
            timeline,
            dashboardStats: {
              ...s.dashboardStats,
              paymentGateStatus,
              lastPaymentTimestamp: lastPaymentEvent?.timestamp,
              lastPaymentAmountUsdc: (lastPaymentEvent?.meta as any)?.total_usd ?? s.dashboardStats.lastPaymentAmountUsdc,
            },
          };
        });
      } catch (err) {
        console.error("poll error:", err);
      }
    }

    poll();
    pollTimerRef.current = window.setInterval(poll, 3000);

    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const setMode = useCallback((mode: SimulationMode) => {
    setState((s) => ({ ...s, mode }));
  }, []);

  const setBusinessCase = useCallback((businessCase: BusinessCase | null) => {
    setState((s) => ({ ...s, selectedBusinessCase: businessCase }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({ ...initialState, mode: s.mode, selectedBusinessCase: s.selectedBusinessCase }));
  }, []);

  const abort = useCallback((reason?: string) => {
    setState((s) => ({
      ...s,
      flowState: "ABORTED",
      isRunning: false,
      timeline: addEvent(s.timeline, {
        type: "FLOW_ABORTED",
        title: "Flow Aborted",
        description: reason ?? "Simulation aborted manually",
        status: "error",
      }),
    }));
  }, []);

  const start = useCallback(async () => {
    setState((s) => ({
      ...s,
      isRunning: true,
      flowStartedAt: Date.now(),
      flowState: "NEED_ACCESS",
      timeline: [],
      dashboardStats: { ...s.dashboardStats, paymentGateStatus: "None" },
    }));
  }, []);

  const sessionDurationSec = state.flowStartedAt ? Math.floor((Date.now() - state.flowStartedAt) / 1000) : 0;

  const value = useMemo(
    () => ({ state, setMode, setBusinessCase, start, abort, reset, sessionDurationSec }),
    [state, setMode, setBusinessCase, start, abort, reset, sessionDurationSec]
  );

  return <SimulationContext.Provider value={value}>{children}</SimulationContext.Provider>;
}

export function useSimulation() {
  const ctx = useContext(SimulationContext);
  if (!ctx) throw new Error("useSimulation must be used inside <SimulationProvider />");
  return ctx;
}

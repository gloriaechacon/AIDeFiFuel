export type SimulationMode = "local" | "testnet";

export type RefuelFlowState =
    | "NEED_FUEL"
    | "WAITING_PAYMENT"
    | "PAYMENT_CONFIRMED"
    | "REFUELING"
    | "COMPLETED"
    | "ABORTED";

export type TimelineEventType =
    | "QUOTE_REQUESTED"
    | "QUOTE_RECEIVED"
    | "PAYMENT_REQUIRED_402"
    | "PAYMENT_SUBMITTED"
    | "PAYMENT_VERIFIED"
    | "FUEL_UNLOCKED"
    | "REFUEL_COMPLETED"
    | "ERROR";

export interface TimelineEvent {
    id: string;
    type: TimelineEventType;
    title: string;
    description: string;
    timestamp: number;
    meta?: Record<string, string>;
    status?: "success" | "warning" | "info"| "error";
}

export interface DashboardStats {
    vaultBalanceUsdc: number;
    yieldEarnedUsdc: number;
    lastRefuelTimestamp?: number;
    lastRefuelAmountUsdc?: number;
    paymentGateStatus: "Verified" | "Pending" | "None";
}

export interface SimulationState {
    mode: SimulationMode;
    isRunning: boolean;
    flowState: RefuelFlowState;
    flowStartedAt?: number;
    timeline: TimelineEvent[];
    dashboardStats: DashboardStats;
}
"use client";

import styles from "./flow-status.module.css";
import { useSimulation } from "../simulation/useSimulation";
import type { RefuelFlowState } from "../simulation/types";
import { FlowItem } from "./flow-item";

const steps: RefuelFlowState[] = [
  "NEED_FUEL",
  "WAITING_PAYMENT",
  "PAYMENT_CONFIRMED",
  "REFUELING",
  "COMPLETED",
];

function stepIndex(step: RefuelFlowState) {
  return steps.indexOf(step);
}

export function FlowStatus() {
  const { state } = useSimulation();
  const currentIdx = stepIndex(state.flowState);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>Current Flow</h2>
        <span className={styles.sub}>
          {state.isRunning ? "Running" : "Idle"}
        </span>
      </div>

      <div className={styles.list}>
        {steps.map((s, idx) => (
          <FlowItem
            key={s}
            label={s}
            status={idx < currentIdx ? "done" : idx === currentIdx ? "active" : "todo"}
          />
        ))}
      </div>
    </div>
  );
}

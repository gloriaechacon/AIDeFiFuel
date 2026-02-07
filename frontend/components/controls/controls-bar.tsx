"use client";

import styles from "./controls-bar.module.css";
import { ToggleOption } from "./toggle-option";
import { useSimulation } from "../simulation/simulation-context";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function ControlsBar() {
    const { state, setMode, setBusinessCase } = useSimulation();
    const isLocal = state.mode === "local";

    return (
        <div className={styles.controls}>
            <div className={styles.mode}>
                <ToggleOption
                    label={`Local Simulation: ${isLocal ? "ON" : "OFF"}`}
                    active={isLocal}
                    onClick={() => setMode(isLocal ? "testnet" : "local")}
                />
                <ToggleOption
                    label={`Vending Machine: ${state.selectedBusinessCase === "vending_machine" ? "ON" : "OFF"}`}
                    active={state.selectedBusinessCase === "vending_machine"}
                    onClick={() =>
                        setBusinessCase(state.selectedBusinessCase === "vending_machine" ? null : "vending_machine")
                    }
                />
                <ToggleOption
                    label={`Laundry: ${state.selectedBusinessCase === "laundry" ? "ON" : "OFF"}`}
                    active={state.selectedBusinessCase === "laundry"}
                    onClick={() =>
                        setBusinessCase(state.selectedBusinessCase === "laundry" ? null : "laundry")
                    }
                />
                <ToggleOption
                    label={`Gas Station: ${state.selectedBusinessCase === "gas_station" ? "ON" : "OFF"}`}
                    active={state.selectedBusinessCase === "gas_station"}
                    onClick={() =>
                        setBusinessCase(state.selectedBusinessCase === "gas_station" ? null : "gas_station")
                    }
                />
            </div>
            <ConnectButton />
        </div>
    )
}

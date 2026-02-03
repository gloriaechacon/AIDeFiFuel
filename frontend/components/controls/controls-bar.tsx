"use client";

import styles from "./controls-bar.module.css";
import { ToggleOption } from "./toggle-option";
import { Button } from "./button";
import { useSimulation } from "../simulation/useSimulation";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function ControlsBar() {
    const { state, setMode, start, reset } = useSimulation();

    return (
        <div className={styles.controls}>
            <div className={styles.mode}>
                <ToggleOption
                    label="Local Simulation"
                    active={state.mode === "local"}
                    onClick={() => setMode("local")} />
                <ToggleOption
                    label="Testnet"
                    active={state.mode === "testnet"}
                    onClick={() => setMode("testnet")} />
            </div>
            <Button onClick={start} disabled={state.isRunning}>Start Session </Button>
            <Button onClick={reset}>Reset</Button>
            <div className={styles.wallet}>
                <ConnectButton />
            </div>
        </div>
    )
}
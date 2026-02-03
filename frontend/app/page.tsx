"use client";

import styles from "./page.module.css";
import { Header } from "../components/header/header";
import { FlowStatus } from "../components/flow-status/flow-status";

export default function Page() {
  return (
    <main className={styles.page}>
      <Header />
       <section className={styles.gridMain}>
        {/* <Timeline /> */}
        <FlowStatus />
      </section>
    </main>
  );
}

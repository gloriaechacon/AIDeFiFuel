import { WalletConnect } from "@/components/wallet-connect"
import WalletStatus from "@/components/wallet-status"

export default function Home() {
  return (
    <main>
      <h1>AIDeFiFuel DashBoard</h1>
      <WalletConnect />

      <div>
        <WalletStatus />
      </div>
    </main>
  )
}
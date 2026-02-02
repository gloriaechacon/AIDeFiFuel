'use client'

import { WagmiProvider } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RainbowKitProvider } from "@rainbow-me/rainbowkit"
import '@rainbow-me/rainbowkit/styles.css'
import { wagmiConfig } from "../wallet/wagmi"

const queryClient = new QueryClient()

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={queryClient}>
                <RainbowKitProvider>
                    {children}
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    )
}
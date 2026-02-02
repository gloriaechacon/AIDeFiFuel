import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia, mainnet } from "wagmi/chains";

const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || 'TEMP_PROJECT_ID';

export const wagmiConfig = getDefaultConfig({
    appName: 'AIDeFiFuel',
    projectId,
    chains: [sepolia, mainnet],
    ssr: true,
})
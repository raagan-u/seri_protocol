import {
  useAccounts,
  useConnect,
  useDisconnect,
  usePhantom,
  useSolana,
  useIsExtensionInstalled,
} from "@phantom/react-sdk";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";

type SolanaTx = Transaction | VersionedTransaction;

export interface SeriWallet {
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  extensionInstalled: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (msg: string) => Promise<{ signature: Uint8Array; publicKey: string }>;
  signAndSendTransaction: (tx: SolanaTx) => Promise<{ signature: string }>;
}

export function useWallet(): SeriWallet {
  const { isConnected, isConnecting: ctxConnecting } = usePhantom();
  const { connect, isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const accounts = useAccounts();
  const { solana } = useSolana();
  const { isInstalled } = useIsExtensionInstalled();

  const solanaAccount = accounts?.find(
    (a) => a.addressType?.toString().toLowerCase().includes("solana")
  );
  const publicKey = solanaAccount?.address ?? solana.publicKey ?? null;

  return {
    publicKey,
    isConnected: Boolean(isConnected && publicKey),
    isConnecting: isConnecting || ctxConnecting,
    extensionInstalled: Boolean(isInstalled),
    connect: async () => {
      await connect({ provider: isInstalled ? "injected" : "phantom" });
    },
    disconnect: async () => {
      await disconnect();
    },
    signMessage: (msg) => solana.signMessage(msg),
    signAndSendTransaction: (tx) => solana.signAndSendTransaction(tx),
  };
}

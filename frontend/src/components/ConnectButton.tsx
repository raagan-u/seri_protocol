import { useState } from "react";
import { Button } from "./primitives";
import { shortAddr } from "../format";
import { useWallet } from "../hooks/useWallet";

export function ConnectButton() {
  const { publicKey, isConnected, isConnecting, extensionInstalled, connect, disconnect } =
    useWallet();
  const [err, setErr] = useState<string | null>(null);

  const handleConnect = async () => {
    setErr(null);
    try {
      await connect();
    } catch (e) {
      setErr((e as Error).message ?? "Failed to connect");
    }
  };

  if (isConnected && publicKey) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          className="num"
          style={{ fontSize: 11, color: "var(--text-3)", letterSpacing: "0.1em" }}
        >
          SOL · {shortAddr(publicKey)}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }

  if (!extensionInstalled) {
    return (
      <a
        href="https://phantom.app/download"
        target="_blank"
        rel="noreferrer"
        style={{ textDecoration: "none" }}
      >
        <Button variant="ghost" size="sm">
          Install Phantom
        </Button>
      </a>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {err && (
        <span style={{ fontSize: 11, color: "var(--danger)" }}>{err}</span>
      )}
      <Button
        variant="primary"
        size="sm"
        onClick={() => void handleConnect()}
        disabled={isConnecting}
      >
        {isConnecting ? "Connecting…" : "Connect wallet"}
      </Button>
    </div>
  );
}

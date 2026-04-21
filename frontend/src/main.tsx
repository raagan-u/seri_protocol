import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PhantomProvider, AddressType, darkTheme } from "@phantom/react-sdk";
import App from "./App";
import "./theme.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");

const appId = import.meta.env.VITE_PHANTOM_APP_ID;

createRoot(rootEl).render(
  <StrictMode>
    <PhantomProvider
      config={{
        providers: appId ? ["injected", "phantom"] : ["injected"],
        ...(appId ? { appId } : {}),
        addressTypes: [AddressType.solana],
      }}
      theme={darkTheme}
      appName="Seri Protocol"
    >
      <App />
    </PhantomProvider>
  </StrictMode>
);

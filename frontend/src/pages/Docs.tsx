import { Button, Card, Label } from "../components/primitives";
import { ConnectButton } from "../components/ConnectButton";
import { browseUrl, createAuctionUrl } from "../navigation";

const DOCS = [
  {
    title: "Product Brief",
    path: "docs/specs/2026-04-09-cca-product-brief-for-design.md",
    summary:
      "High-level explanation of the continuous clearing auction and the end-user flows for creators and bidders.",
    bullets: [
      "How creators launch auctions and define supply schedules",
      "How bidders place bids, monitor clearing price, and claim or refund",
      "The success vs failed-auction outcomes the UI needs to explain clearly",
    ],
  },
  {
    title: "Solana Port Design",
    path: "docs/specs/2026-04-09-cca-solana-port-design.md",
    summary:
      "On-chain architecture for the Anchor program: PDAs, checkpoint math, Q64 pricing, and lifecycle instructions.",
    bullets: [
      "Auction, bid, tick, and checkpoint account model",
      "Why the protocol uses Q64 math and timestamp-based checkpoints",
      "Instruction surface from initialize to claim/exit flows",
    ],
  },
  {
    title: "Backend & Frontend Spec",
    path: "docs/specs/2026-04-17-backend-frontend-design.md",
    summary:
      "Full-stack app architecture: Axum backend, indexer, crank, REST/WS APIs, and the marketplace UI.",
    bullets: [
      "REST and websocket responsibilities across the backend",
      "Browse, detail, and create-auction app structure",
      "Cached Postgres schema and real-time data flow expectations",
    ],
  },
] as const;

export function Docs() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text)",
        padding: "48px 24px 80px",
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <TopBar />

        <div style={{ marginTop: 28, marginBottom: 28 }}>
          <Label>Protocol Docs</Label>
          <h1 style={{ margin: "10px 0 0", fontSize: 34, letterSpacing: "-0.03em" }}>
            Reference guides for Seri Protocol
          </h1>
          <p style={{ marginTop: 10, color: "var(--text-muted)", maxWidth: 760, lineHeight: 1.6 }}>
            These are the core design documents that explain the protocol, the Solana program
            model, and the current backend/frontend architecture. The canonical markdown lives in
            the repo’s `docs/` directory.
          </p>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          {DOCS.map((doc) => (
            <Card key={doc.title} pad={24}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <Label>{doc.title}</Label>
                  <div style={{ marginTop: 10, fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}>
                    {doc.title}
                  </div>
                  <p style={{ marginTop: 10, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    {doc.summary}
                  </p>
                </div>
                <div
                  style={{
                    alignSelf: "flex-start",
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--border)",
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--text-3)",
                  }}
                >
                  Markdown
                </div>
              </div>

              <div
                style={{
                  marginTop: 14,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "rgba(255,255,255,0.02)",
                  fontSize: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "var(--text-muted)",
                  overflowX: "auto",
                }}
              >
                {doc.path}
              </div>

              <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
                {doc.bullets.map((bullet) => (
                  <div
                    key={bullet}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      color: "var(--text)",
                      lineHeight: 1.5,
                    }}
                  >
                    <span style={{ color: "var(--accent)" }}>•</span>
                    <span>{bullet}</span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>

        <Card pad={24} style={{ marginTop: 18 }}>
          <Label>Current App</Label>
          <div style={{ marginTop: 12, display: "grid", gap: 8, color: "var(--text-muted)", lineHeight: 1.6 }}>
            <div>Browse, auction detail, and create-auction flows are all routed with query params.</div>
            <div>The backend builds unsigned Solana transactions for bidding and auction initialization.</div>
            <div>The indexer and websocket layer keep cached auction state available to the frontend.</div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function TopBar() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <a
          href={browseUrl()}
          style={{
            color: "var(--text-muted)",
            textDecoration: "none",
            fontSize: 13,
          }}
        >
          ← Back to browse
        </a>
        <a
          href={createAuctionUrl()}
          style={{
            color: "var(--text-muted)",
            textDecoration: "none",
            fontSize: 13,
          }}
        >
          Launch auction
        </a>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <a href={browseUrl()} style={{ textDecoration: "none" }}>
          <Button variant="ghost" size="md">
            Auctions
          </Button>
        </a>
        <a href={createAuctionUrl()} style={{ textDecoration: "none" }}>
          <Button size="md">Launch</Button>
        </a>
        <ConnectButton />
      </div>
    </div>
  );
}

import { Button, Card, Label } from "../components/primitives";
import { ConnectButton } from "../components/ConnectButton";
import { browseUrl, createAuctionUrl } from "../navigation";

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
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <TopBar />

        <header style={{ marginTop: 28, marginBottom: 28 }}>
          <Label>How Seri works</Label>
          <h1 style={{ margin: "10px 0 0", fontSize: 34, letterSpacing: "-0.03em" }}>
            A fair price for everyone, found by the market.
          </h1>
          <p
            style={{
              marginTop: 12,
              color: "var(--text-muted)",
              maxWidth: 720,
              lineHeight: 1.65,
              fontSize: 15,
            }}
          >
            Seri is a token launch platform built on a{" "}
            <strong style={{ color: "var(--text)" }}>continuous clearing auction</strong>{" "}
            (CCA). Instead of a first-come-first-served sale, every bidder pays the same
            final price — the one the market actually settles on. No insider floor, no
            bot race, no fixed-price scramble.
          </p>
        </header>

        <Section label="The idea in one paragraph" title="Bid your max, pay the clearing price">
          <p style={p}>
            Tell the auction the most you'd pay per token and how much currency you're
            willing to put up. As more demand arrives, a single market-wide{" "}
            <em>clearing price</em> rises. When the auction ends, every winning bidder
            pays the <em>same</em> final clearing price — even if they bid higher. The
            difference between your max and clearing comes back to you as a refund.
          </p>
        </Section>

        <Section label="For bidders" title="Three ways your bid can land">
          <Row
            head="You bid above the final clearing"
            body="Fully filled. You receive your tokens at the clearing price and get a
              refund of the difference between what you deposited and what those tokens
              actually cost."
            tone="accent"
          />
          <Row
            head="Your max equals the final clearing"
            body="Partially filled. You share the last tick pro-rata with other bidders
              at the same price. You get some tokens and a refund of the unfilled
              portion."
            tone="warn"
          />
          <Row
            head="The clearing price moves above your max"
            body="Outbid. You stop accruing new tokens, but you keep anything you earned
              while your max was still in play. Raise your max to come back in, or exit
              for a refund."
            tone="muted"
          />
        </Section>

        <Section label="For creators" title="What you set when you launch">
          <Bullet>The token to sell, and the total amount.</Bullet>
          <Bullet>
            The currency you accept (USDC, SOL, or any SPL token), and a floor price.
          </Bullet>
          <Bullet>
            Start, end, and claim times — wall-clock or by Solana slot, your choice.
          </Bullet>
          <Bullet>
            A supply schedule: how fast tokens get released over the auction window
            (flat, frontloaded, backloaded, or fully custom).
          </Bullet>
          <Bullet>
            A fundraising minimum. If the auction doesn't clear that bar, every bidder
            gets fully refunded and no tokens go out.
          </Bullet>
        </Section>

        <Section label="What &quot;graduates&quot; means" title="Pass / fail at the end">
          <p style={p}>
            When the auction window closes, Seri runs one final accounting pass. If the
            currency raised at the final clearing price meets or exceeds the creator's
            goal, the auction <strong>graduates</strong>: tokens are released to winning
            bidders, refunds are made available, and the creator can sweep the
            currency.
          </p>
          <p style={p}>
            If it falls short, the auction <strong>fails</strong>. Nobody gets tokens
            and every bidder can withdraw their full deposit. Bidders are never
            partially exposed to a half-funded launch.
          </p>
          <p style={{ ...p, color: "var(--text-3)", fontSize: 13 }}>
            <strong style={{ color: "var(--text-muted)" }}>Heads up:</strong> in this
            hackathon build, <em>bootstrapping liquidity</em> from the raised currency
            (auto-seeding a DEX pool, paired LP minting, lockups) is not in scope. On
            graduation the creator simply sweeps the raised funds to the wallet they
            configured at launch — what happens next is off-platform.
          </p>
        </Section>

        <Section label="Why CCA" title="Why we don't just sell at a fixed price">
          <Bullet>
            <strong>One price for everyone.</strong> Whales don't pay less than retail;
            retail doesn't pay more than whales. The clearing price is the single
            number that matched supply to demand.
          </Bullet>
          <Bullet>
            <strong>No launch-second race.</strong> A fixed-price floor sale rewards
            whoever has the fastest bot. CCA spreads the auction over a window so
            humans can think and react.
          </Bullet>
          <Bullet>
            <strong>Refunds are first-class.</strong> Overpayers, outbids, and
            failed-graduation bidders all redeem their currency back without an
            external claim portal.
          </Bullet>
        </Section>

        <Section label="The flow" title="What happens, step by step">
          <Step n={1} text="Creator configures the auction and locks in the token supply." />
          <Step n={2} text="Auction goes live. Tokens release on the schedule the creator picked." />
          <Step n={3} text="Bidders place bids with a max price and a currency deposit." />
          <Step n={4} text="The clearing price walks up as demand arrives. Bids above clearing accrue tokens; bids below pause." />
          <Step n={5} text="At end-time, the auction graduates (raised ≥ goal) or fails (raised < goal)." />
          <Step n={6} text="Bidders claim tokens and refunds. Failed-auction bidders withdraw 100% of their deposit." />
        </Section>

        <Card pad={24} style={{ marginTop: 24 }}>
          <Label>Ready to try it?</Label>
          <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a href={browseUrl()} style={{ textDecoration: "none" }}>
              <Button variant="ghost" size="md">
                Browse live auctions
              </Button>
            </a>
            <a href={createAuctionUrl()} style={{ textDecoration: "none" }}>
              <Button size="md">Launch your own</Button>
            </a>
          </div>
        </Card>

        <p
          style={{
            marginTop: 28,
            color: "var(--text-3)",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          Looking for the engineering specs (account model, instruction surface,
          backend architecture)? They live in the repo's <code>docs/</code> directory.
        </p>
      </div>
    </div>
  );
}

const p: React.CSSProperties = {
  margin: "0 0 12px",
  color: "var(--text-muted)",
  lineHeight: 1.65,
  fontSize: 14,
};

function Section({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card pad={24} style={{ marginBottom: 16 }}>
      <Label>{label}</Label>
      <div
        style={{
          marginTop: 10,
          marginBottom: 14,
          fontSize: 20,
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        {title}
      </div>
      {children}
    </Card>
  );
}

function Row({
  head,
  body,
  tone,
}: {
  head: string;
  body: string;
  tone: "accent" | "warn" | "muted";
}) {
  const dot =
    tone === "accent"
      ? "var(--accent)"
      : tone === "warn"
      ? "var(--warn, #f0b860)"
      : "var(--text-3)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "10px 1fr",
        gap: 12,
        marginTop: 12,
        alignItems: "start",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: dot,
          marginTop: 8,
        }}
      />
      <div>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{head}</div>
        <div style={{ marginTop: 4, color: "var(--text-muted)", lineHeight: 1.6, fontSize: 14 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        marginTop: 10,
        color: "var(--text-muted)",
        lineHeight: 1.6,
        fontSize: 14,
      }}
    >
      <span style={{ color: "var(--accent)", marginTop: 2 }}>•</span>
      <span>{children}</span>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr",
        gap: 12,
        marginTop: 10,
        alignItems: "start",
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 999,
          border: "1px solid var(--border)",
          color: "var(--text-muted)",
          fontSize: 12,
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {n}
      </span>
      <div style={{ color: "var(--text-muted)", lineHeight: 1.6, fontSize: 14 }}>
        {text}
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

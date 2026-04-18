import type { Bid } from "../api/types";
import { fmtCurrency, fmtPrice, fmtTokens } from "../format";
import { Button, Card, BidStatusPill } from "./primitives";
import { ExplainerRow, Stat } from "./BidForm";

export type BidCardMode =
  | "none"
  | "active"
  | "at_risk"
  | "outbid"
  | "partially_filled"
  | "graduated"
  | "failed";

export function BidStatusCard({
  mode,
  bid,
  clearingPrice,
  requiredRaise,
}: {
  mode: BidCardMode;
  bid: Bid | null;
  clearingPrice: number;
  requiredRaise: number;
}) {
  if (mode === "none" || !bid) return null;

  const maxPrice = Number(bid.maxPrice);
  const deposit = Number(bid.amount);
  const estRefund = Number(bid.estimatedRefund);

  const header = (pill: Parameters<typeof BidStatusPill>[0]["status"]) => (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "-0.01em" }}>
          Your bid
        </div>
        <BidStatusPill status={pill} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 4,
        }}
      >
        <Stat label="Max price" value={fmtPrice(maxPrice, 3)} />
        <Stat label="Deposit" value={fmtCurrency(deposit, "USDC", 0)} />
      </div>
    </div>
  );

  if (mode === "active" || mode === "at_risk") {
    const headroom = ((maxPrice - clearingPrice) / clearingPrice) * 100;
    return (
      <Card pad={20}>
        {header(mode === "active" ? "active" : "at_risk")}
        <ExplainerRow tone={mode === "at_risk" ? "warn" : "accent"}>
          {mode === "active" ? (
            <>
              Your max is <strong className="num">{headroom.toFixed(1)}%</strong> above
              clearing. You're comfortably in.
            </>
          ) : (
            <>
              Clearing is within <strong className="num">{headroom.toFixed(1)}%</strong>{" "}
              of your max. Raise it or add more to stay safe.
            </>
          )}
        </ExplainerRow>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginTop: 14,
          }}
        >
          <Stat
            label="Tokens (est.)"
            value={fmtTokens(bid.estimatedTokens, 2)}
            suffix="AQUA"
          />
          <Stat label="Refund (est.)" value={fmtCurrency(estRefund, "USDC", 0)} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Button variant="ghost" size="sm" style={{ flex: 1 }}>
            Raise max
          </Button>
          <Button variant="ghost" size="sm" style={{ flex: 1 }}>
            Add deposit
          </Button>
          <Button variant="ghost" size="sm">
            Exit
          </Button>
        </div>
      </Card>
    );
  }

  if (mode === "outbid") {
    const accrued = bid.estimatedTokens;
    return (
      <Card pad={20}>
        {header("outbid")}
        <ExplainerRow tone="warn">
          Clearing is now{" "}
          <strong className="num">{fmtPrice(clearingPrice, 3)}</strong>, above your max —
          you've stopped accruing new tokens, but you keep everything you earned while
          your max was in play. Raise your max to resume, or exit now to claim what
          you've got.
        </ExplainerRow>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginTop: 14,
          }}
        >
          <Stat
            label="Tokens accrued"
            value={accrued > 0 ? fmtTokens(accrued, 2) : "0"}
            suffix="AQUA"
          />
          <Stat
            label="Refund available"
            value={fmtCurrency(estRefund, "USDC", 0)}
            tone="accent"
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Button variant="primary" size="sm" style={{ flex: 1 }}>
            Raise max to resume
          </Button>
          <Button variant="ghost" size="sm">
            Exit now
          </Button>
        </div>
      </Card>
    );
  }

  if (mode === "partially_filled") {
    return (
      <Card pad={20}>
        {header("partial")}
        <ExplainerRow tone="warn">
          Your max equals the current clearing price. You're filling pro-rata with other
          bids at this tick — new tokens accrue more slowly than fully-active bids. If
          clearing moves up, you pause; if it drops back, you resume at full rate.
        </ExplainerRow>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginTop: 14,
          }}
        >
          <Stat
            label="Tokens (est.)"
            value={fmtTokens(bid.estimatedTokens, 2)}
            suffix="AQUA"
          />
          <Stat label="Refund (est.)" value={fmtCurrency(estRefund, "USDC", 0)} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Button variant="ghost" size="sm" style={{ flex: 1 }}>
            Raise max
          </Button>
          <Button variant="ghost" size="sm" style={{ flex: 1 }}>
            Exit partial
          </Button>
        </div>
      </Card>
    );
  }

  if (mode === "graduated") {
    const finalTokens = bid.tokensFilled || bid.estimatedTokens;
    return (
      <Card pad={20}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "-0.01em" }}>
            Your allocation
          </div>
          <BidStatusPill status="claimable" />
        </div>
        <ExplainerRow tone="accent">
          Auction graduated at{" "}
          <strong className="num">{fmtPrice(clearingPrice, 3)}</strong>. Your tokens and
          any overpayment are ready to claim.
        </ExplainerRow>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginTop: 14,
          }}
        >
          <Stat
            label="Tokens"
            value={fmtTokens(finalTokens, 2)}
            suffix="AQUA"
            tone="accent"
          />
          <Stat label="Refund" value={fmtCurrency(estRefund, "USDC", 0)} />
        </div>
        <Button variant="primary" size="lg" full style={{ marginTop: 16 }}>
          Claim {fmtTokens(finalTokens, 2)} AQUA
        </Button>
      </Card>
    );
  }

  if (mode === "failed") {
    const refund = Number(bid.amount);
    return (
      <Card pad={20}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500 }}>Your refund</div>
          <BidStatusPill status="failed" />
        </div>
        <ExplainerRow tone="neutral">
          Auction did not reach its {fmtCurrency(requiredRaise, "USDC", 0)} goal. All bids
          are fully refundable.
        </ExplainerRow>
        <div style={{ marginTop: 14 }}>
          <Stat
            label="Full refund available"
            value={fmtCurrency(refund, "USDC", 0)}
            tone="accent"
            large
          />
        </div>
        <Button variant="primary" size="lg" full style={{ marginTop: 16 }}>
          Withdraw {fmtCurrency(refund, "USDC", 0)}
        </Button>
      </Card>
    );
  }

  return null;
}

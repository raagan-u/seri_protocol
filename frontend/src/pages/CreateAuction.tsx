import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Transaction } from "@solana/web3.js";
import { Button, Card, Label } from "../components/primitives";
import { ConnectButton } from "../components/ConnectButton";
import { buildInitTx, persistAuctionMetadata, type AuctionMetadataBody } from "../api/client";
import type {
  AuctionStepInput,
  CreateAuctionPayload,
  EmissionPreset,
  InitializeAuctionParamsInput,
} from "../api/types";
import { useWallet } from "../hooks/useWallet";
import { auctionUrl, browseUrl } from "../navigation";

// ---- preset → steps math ---------------------------------------------------

const MPS_TOTAL = 10_000_000;

// Split `weight` (integer) across `duration` integer seconds into 1–2 steps
// such that Σ mps·duration = weight exactly.
function exactSteps(weight: number, duration: number): AuctionStepInput[] {
  if (duration <= 0 || weight <= 0) return [];
  const k = Math.floor(weight / duration);
  const r = weight - k * duration;
  if (r === 0) return [{ mps: k, duration }];
  // (k+1)*r + k*(duration-r) = weight
  const out: AuctionStepInput[] = [];
  if (r > 0) out.push({ mps: k + 1, duration: r });
  if (duration - r > 0 && k > 0) out.push({ mps: k, duration: duration - r });
  return out;
}

// Split full auction duration D into N phases of roughly equal length, then
// distribute MPS_TOTAL across phases by `weightFractions` (must sum to 1).
// Largest-remainder method ensures Σ weights = MPS_TOTAL exactly.
function buildPhases(D: number, weightFractions: number[]): AuctionStepInput[] {
  const N = weightFractions.length;
  const baseDur = Math.floor(D / N);
  const durations = Array<number>(N).fill(baseDur);
  durations[N - 1] = D - baseDur * (N - 1);

  const ideal = weightFractions.map((f) => f * MPS_TOTAL);
  const weights = ideal.map(Math.floor);
  let deficit = MPS_TOTAL - weights.reduce((a, b) => a + b, 0);
  const order = ideal
    .map((w, i) => ({ i, frac: w - Math.floor(w) }))
    .sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < deficit; j++) weights[order[j % N].i] += 1;

  const out: AuctionStepInput[] = [];
  for (let i = 0; i < N; i++) out.push(...exactSteps(weights[i], durations[i]));
  return out;
}

function buildStepsForPreset(preset: EmissionPreset, D: number): AuctionStepInput[] {
  if (D <= 0) return [];
  switch (preset) {
    case "flat":
      return exactSteps(MPS_TOTAL, D);
    case "frontloaded":
      return buildPhases(D, [0.7, 0.3]);
    case "backloaded":
      return buildPhases(D, [0.3, 0.7]);
    case "linear-decay":
      return buildPhases(D, [0.4, 0.3, 0.2, 0.1]);
  }
}

const PRESET_COPY: Record<EmissionPreset, { label: string; blurb: string }> = {
  flat: {
    label: "Flat",
    blurb: "Emit supply at a constant rate across the entire auction.",
  },
  frontloaded: {
    label: "Frontloaded",
    blurb: "70% of supply in the first half, 30% in the second.",
  },
  backloaded: {
    label: "Backloaded",
    blurb: "30% of supply in the first half, 70% in the second.",
  },
  "linear-decay": {
    label: "Linear decay",
    blurb: "40 / 30 / 20 / 10 across four equal phases — heavy early, light late.",
  },
};

// ---- form state ------------------------------------------------------------

interface FormState {
  // identity
  tokenName: string;
  tokenSymbol: string;
  tokenTagline: string;
  tokenDescription: string;
  tokenIconUrl: string;
  // setup
  tokenMint: string;
  currencyMint: string;
  totalSupply: string;
  // schedule (datetime-local strings, e.g. "2026-05-01T10:00")
  startTime: string;
  endTime: string;
  claimTime: string;
  // pricing
  floorPrice: string;
  tickSpacing: string;
  requiredCurrencyRaised: string;
  // emission
  preset: EmissionPreset;
  // recipients
  fundsRecipient: string;
  tokensRecipient: string;
}

const BLANK: FormState = {
  tokenName: "",
  tokenSymbol: "",
  tokenTagline: "",
  tokenDescription: "",
  tokenIconUrl: "",
  tokenMint: "",
  currencyMint: "",
  totalSupply: "",
  startTime: "",
  endTime: "",
  claimTime: "",
  floorPrice: "",
  tickSpacing: "2",
  requiredCurrencyRaised: "",
  preset: "flat",
  fundsRecipient: "",
  tokensRecipient: "",
};

// ---- validation ------------------------------------------------------------

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function toUnix(dtLocal: string): number {
  // datetime-local is interpreted in the user's local tz; Date parses it that way.
  const ms = new Date(dtLocal).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

function toDatetimeLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Errors = Partial<Record<keyof FormState | "steps", string>>;

function validate(f: FormState): Errors {
  const e: Errors = {};
  if (!f.tokenName.trim()) e.tokenName = "Required";
  if (!f.tokenSymbol.trim()) e.tokenSymbol = "Required";
  else if (f.tokenSymbol.length > 10) e.tokenSymbol = "Keep ≤ 10 chars";

  if (!BASE58_RE.test(f.tokenMint)) e.tokenMint = "Invalid base58 address";
  if (!BASE58_RE.test(f.currencyMint)) e.currencyMint = "Invalid base58 address";
  if (!BASE58_RE.test(f.fundsRecipient)) e.fundsRecipient = "Invalid base58 address";
  if (!BASE58_RE.test(f.tokensRecipient)) e.tokensRecipient = "Invalid base58 address";

  const supply = Number(f.totalSupply);
  if (!(supply > 0)) e.totalSupply = "Must be > 0";

  const start = toUnix(f.startTime);
  const end = toUnix(f.endTime);
  const claim = toUnix(f.claimTime);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(start)) e.startTime = "Required";
  else if (start <= nowSec) e.startTime = "Must be in the future";
  if (!Number.isFinite(end)) e.endTime = "Required";
  else if (Number.isFinite(start) && end <= start) e.endTime = "Must be after start";
  if (!Number.isFinite(claim)) e.claimTime = "Required";
  else if (Number.isFinite(end) && claim < end) e.claimTime = "Must be ≥ end";

  const floor = Number(f.floorPrice);
  if (!(floor > 0)) e.floorPrice = "Must be > 0";
  const tick = Number(f.tickSpacing);
  if (!Number.isInteger(tick) || tick < 2) e.tickSpacing = "Integer ≥ 2";
  const required = Number(f.requiredCurrencyRaised);
  if (!(required > 0)) e.requiredCurrencyRaised = "Must be > 0";

  // steps sanity from preset + duration
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const steps = buildStepsForPreset(f.preset, end - start);
    if (steps.length === 0) e.steps = "Could not build steps from duration";
    else {
      const wSum = steps.reduce((a, s) => a + s.mps * s.duration, 0);
      const dSum = steps.reduce((a, s) => a + s.duration, 0);
      if (wSum !== MPS_TOTAL) e.steps = `Weight sum ${wSum} ≠ ${MPS_TOTAL}`;
      if (dSum !== end - start) e.steps = `Duration sum ${dSum} ≠ ${end - start}`;
    }
  }
  return e;
}

function buildPayload(f: FormState, creator: string): CreateAuctionPayload {
  const start = toUnix(f.startTime);
  const end = toUnix(f.endTime);
  const claim = toUnix(f.claimTime);
  const steps = buildStepsForPreset(f.preset, end - start);
  const params: InitializeAuctionParamsInput = {
    totalSupply: f.totalSupply,
    startTime: start,
    endTime: end,
    claimTime: claim,
    tickSpacing: Number(f.tickSpacing),
    floorPrice: f.floorPrice,
    requiredCurrencyRaised: f.requiredCurrencyRaised,
    tokensRecipient: f.tokensRecipient,
    fundsRecipient: f.fundsRecipient,
    steps,
  };
  const metadata = {
    tokenName: f.tokenName,
    tokenSymbol: f.tokenSymbol,
    tokenTagline: f.tokenTagline || undefined,
    tokenDescription: f.tokenDescription || undefined,
    tokenIconUrl: f.tokenIconUrl || undefined,
  };
  return {
    creator,
    tokenMint: f.tokenMint,
    currencyMint: f.currencyMint,
    preset: f.preset,
    params,
    metadata,
  };
}

function toMetadataBody(payload: CreateAuctionPayload): AuctionMetadataBody {
  return {
    token_name: payload.metadata.tokenName,
    token_symbol: payload.metadata.tokenSymbol,
    token_tagline: payload.metadata.tokenTagline,
    token_icon_url: payload.metadata.tokenIconUrl,
    description: payload.metadata.tokenDescription,
  };
}

// ---- page ------------------------------------------------------------------

type SubmitState = "idle" | "building" | "signing" | "syncing" | "success" | "error";

export function CreateAuction({ wallet }: { wallet: string | null }) {
  const { publicKey, isConnected, signAndSendTransaction } = useWallet();
  const [form, setForm] = useState<FormState>(BLANK);
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, true>>>({});
  const [submit, setSubmit] = useState<SubmitState>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [auctionPda, setAuctionPda] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const effectiveWallet = publicKey ?? wallet;

  // Pre-fill recipients from connected wallet (one-shot when wallet first appears)
  useEffect(() => {
    if (!effectiveWallet) return;
    setForm((f) => ({
      ...f,
      fundsRecipient: f.fundsRecipient || effectiveWallet,
      tokensRecipient: f.tokensRecipient || effectiveWallet,
    }));
  }, [effectiveWallet]);

  const set = <K extends keyof FormState>(k: K) => (v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const markTouched = (k: keyof FormState) =>
    setTouched((t) => ({ ...t, [k]: true }));

  const stepsPreview = useMemo(() => {
    const s = toUnix(form.startTime);
    const e = toUnix(form.endTime);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
    return buildStepsForPreset(form.preset, e - s);
  }, [form.startTime, form.endTime, form.preset]);

  const handleSubmit = async () => {
    const e = validate(form);
    setErrors(e);
    // mark all fields touched so errors render
    setTouched(
      Object.keys(form).reduce<Record<string, true>>((a, k) => {
        a[k] = true;
        return a;
      }, {}) as Partial<Record<keyof FormState, true>>
    );
    if (Object.keys(e).length) return;
    if (!publicKey || !isConnected) {
      setErrMsg("Connect Phantom to sign the initialize transaction.");
      setSubmit("error");
      return;
    }

    const payload = buildPayload(form, publicKey);
    setSubmit("building");
    setErrMsg(null);
    setAuctionPda(null);
    setTxSig(null);
    try {
      const resp = await buildInitTx(payload);
      setAuctionPda(resp.auctionPda);
      setSubmit("signing");

      const raw = Uint8Array.from(atob(resp.tx), (c) => c.charCodeAt(0));
      const transaction = Transaction.from(raw);
      const { signature } = await signAndSendTransaction(transaction);
      console.info("initialize_auction signature:", signature);

      setTxSig(signature);
      setSubmit("syncing");
      const metadataOk = await persistAuctionMetadata(
        resp.auctionPda,
        toMetadataBody(payload)
      );

      if (!metadataOk) {
        setErrMsg(
          "Transaction sent, but the backend indexer has not exposed the new auction yet. You can open it manually in a few seconds."
        );
        setSubmit("error");
        return;
      }

      setSubmit("success");
      window.location.assign(auctionUrl(resp.auctionPda));
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      setSubmit("error");
    }
  };

  const canSubmit =
    Boolean(publicKey && isConnected) &&
    submit !== "building" &&
    submit !== "signing" &&
    submit !== "syncing" &&
    !txSig;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text)",
        padding: "48px 24px 160px",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <TopBar />

        <div style={{ marginTop: 24, marginBottom: 32 }}>
          <h1 style={{ margin: 0, fontSize: 32, letterSpacing: "-0.03em" }}>
            Create auction
          </h1>
          <p style={{ marginTop: 8, color: "var(--text-muted)" }}>
            Launch a continuous-clearing auction. All on-chain parameters are
            validated before submission.
          </p>
        </div>

        <Section title="Token identity">
          <Row>
            <Field label="Token name" err={touched.tokenName ? errors.tokenName : undefined}>
              <Input
                value={form.tokenName}
                onChange={(v) => set("tokenName")(v)}
                onBlur={() => markTouched("tokenName")}
                placeholder="Seri Protocol"
              />
            </Field>
            <Field label="Symbol" err={touched.tokenSymbol ? errors.tokenSymbol : undefined}>
              <Input
                value={form.tokenSymbol}
                onChange={(v) => set("tokenSymbol")(v.toUpperCase())}
                onBlur={() => markTouched("tokenSymbol")}
                placeholder="SERI"
              />
            </Field>
          </Row>
          <Field label="Tagline">
            <Input
              value={form.tokenTagline}
              onChange={(v) => set("tokenTagline")(v)}
              placeholder="One-line hook, shown on the listing card"
            />
          </Field>
          <Field label="Description">
            <TextArea
              value={form.tokenDescription}
              onChange={(v) => set("tokenDescription")(v)}
              placeholder="Longer description shown on the auction detail page"
              rows={4}
            />
          </Field>
          <Field label="Icon URL">
            <Input
              value={form.tokenIconUrl}
              onChange={(v) => set("tokenIconUrl")(v)}
              placeholder="https://…"
            />
          </Field>
        </Section>

        <Section title="Token setup">
          <Field label="Token mint" err={touched.tokenMint ? errors.tokenMint : undefined}>
            <Input
              value={form.tokenMint}
              onChange={(v) => set("tokenMint")(v.trim())}
              onBlur={() => markTouched("tokenMint")}
              placeholder="Base58 mint address"
              mono
            />
          </Field>
          <Field label="Currency mint" err={touched.currencyMint ? errors.currencyMint : undefined}>
            <Input
              value={form.currencyMint}
              onChange={(v) => set("currencyMint")(v.trim())}
              onBlur={() => markTouched("currencyMint")}
              placeholder="Base58 mint address (e.g. USDC)"
              mono
            />
          </Field>
          <Field label="Total supply" err={touched.totalSupply ? errors.totalSupply : undefined}>
            <Input
              value={form.totalSupply}
              onChange={(v) => set("totalSupply")(v)}
              onBlur={() => markTouched("totalSupply")}
              placeholder="1000000"
              suffix="tokens"
            />
          </Field>
        </Section>

        <Section title="Schedule">
          <Row>
            <Field label="Start" err={touched.startTime ? errors.startTime : undefined}>
              <DateTimeInput
                value={form.startTime}
                onChange={(v) => set("startTime")(v)}
                onBlur={() => markTouched("startTime")}
              />
            </Field>
            <Field label="End" err={touched.endTime ? errors.endTime : undefined}>
              <DateTimeInput
                value={form.endTime}
                onChange={(v) => set("endTime")(v)}
                onBlur={() => markTouched("endTime")}
              />
            </Field>
          </Row>
          <Field label="Claim opens" err={touched.claimTime ? errors.claimTime : undefined}>
            <DateTimeInput
              value={form.claimTime}
              onChange={(v) => set("claimTime")(v)}
              onBlur={() => markTouched("claimTime")}
            />
          </Field>
        </Section>

        <Section title="Pricing">
          <Row>
            <Field label="Floor price" err={touched.floorPrice ? errors.floorPrice : undefined}>
              <Input
                value={form.floorPrice}
                onChange={(v) => set("floorPrice")(v)}
                onBlur={() => markTouched("floorPrice")}
                placeholder="0.40"
                suffix="per token"
              />
            </Field>
            <Field label="Tick spacing" err={touched.tickSpacing ? errors.tickSpacing : undefined}>
              <Input
                value={form.tickSpacing}
                onChange={(v) => set("tickSpacing")(v)}
                onBlur={() => markTouched("tickSpacing")}
                placeholder="2"
              />
            </Field>
          </Row>
          <Field
            label="Required raise"
            err={touched.requiredCurrencyRaised ? errors.requiredCurrencyRaised : undefined}
          >
            <Input
              value={form.requiredCurrencyRaised}
              onChange={(v) => set("requiredCurrencyRaised")(v)}
              onBlur={() => markTouched("requiredCurrencyRaised")}
              placeholder="250000"
              suffix="currency units"
            />
          </Field>
        </Section>

        <Section title="Emission schedule">
          <PresetPicker value={form.preset} onChange={(v) => set("preset")(v)} />
          {errors.steps && (
            <div style={{ color: "var(--danger, #e07062)", fontSize: 12, marginTop: 12 }}>
              {errors.steps}
            </div>
          )}
          {stepsPreview && (
            <div style={{ marginTop: 16 }}>
              <Label>Generated steps ({stepsPreview.length})</Label>
              <div
                style={{
                  marginTop: 8,
                  fontFamily: "monospace",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  display: "grid",
                  gap: 4,
                }}
              >
                {stepsPreview.map((s, i) => (
                  <div key={i}>
                    {i + 1}. mps={s.mps}, duration={s.duration}s ({humanDur(s.duration)})
                    &nbsp;·&nbsp;weight={s.mps * s.duration}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>

        <Section title="Recipients">
          <Field label="Funds recipient" err={touched.fundsRecipient ? errors.fundsRecipient : undefined}>
            <Input
              value={form.fundsRecipient}
              onChange={(v) => set("fundsRecipient")(v.trim())}
              onBlur={() => markTouched("fundsRecipient")}
              placeholder="Base58 wallet"
              mono
            />
          </Field>
          <Field
            label="Unsold-tokens recipient"
            err={touched.tokensRecipient ? errors.tokensRecipient : undefined}
          >
            <Input
              value={form.tokensRecipient}
              onChange={(v) => set("tokensRecipient")(v.trim())}
              onBlur={() => markTouched("tokensRecipient")}
              placeholder="Base58 wallet"
              mono
            />
          </Field>
        </Section>

        {/* Banners */}
        {!publicKey && (
          <Banner tone="warn">
            Connect a wallet to create an auction. Your address will auto-fill
            the recipient fields.
          </Banner>
        )}
        {submit === "error" && (
          <Banner tone="warn">
            {txSig
              ? "Auction transaction was sent, but the backend is still catching up."
              : "Create auction failed before the transaction could be sent."}
            {auctionPda && (
              <div style={{ marginTop: 6, opacity: 0.9 }}>
                Auction PDA: <span style={{ fontFamily: "monospace" }}>{auctionPda}</span>
              </div>
            )}
            {txSig && (
              <div style={{ marginTop: 6, opacity: 0.9 }}>
                Signature: <span style={{ fontFamily: "monospace" }}>{txSig}</span>
              </div>
            )}
            {errMsg && <div style={{ marginTop: 6, opacity: 0.8 }}>{errMsg}</div>}
          </Banner>
        )}
        {submit === "signing" && (
          <Banner tone="accent">
            Transaction built. Approve the initialize transaction in Phantom.
          </Banner>
        )}
        {submit === "syncing" && (
          <Banner tone="accent">
            Transaction sent. Waiting for the backend indexer so metadata can be
            attached before redirecting.
          </Banner>
        )}
        {submit === "success" && (
          <Banner tone="accent">
            Auction submitted. Redirecting to the auction detail page…
          </Banner>
        )}

        <div style={{ marginTop: 32, display: "flex", gap: 12 }}>
          <Button
            variant="primary"
            size="lg"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submit === "building"
              ? "Building transaction…"
              : submit === "signing"
                ? "Approve in Phantom…"
                : submit === "syncing"
                  ? "Waiting for indexer…"
                  : "Create auction"}
          </Button>
          {auctionPda && (
            <Button
              variant="ghost"
              size="lg"
              onClick={() => {
                window.location.assign(auctionUrl(auctionPda));
              }}
            >
              Open auction
            </Button>
          )}
          <Button
            variant="ghost"
            size="lg"
            onClick={() => {
              window.location.assign(browseUrl());
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- small sub-components --------------------------------------------------

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
      <ConnectButton />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card pad={24} style={{ marginBottom: 20 }}>
      <Label>{title}</Label>
      <div style={{ marginTop: 16, display: "grid", gap: 14 }}>{children}</div>
    </Card>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      {children}
    </div>
  );
}

function Field({
  label,
  err,
  children,
}: {
  label: string;
  err?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-3)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
      {err && (
        <div style={{ color: "var(--danger, #e07062)", fontSize: 12, marginTop: 4 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function Input({
  value,
  onChange,
  onBlur,
  placeholder,
  type = "text",
  suffix,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  type?: string;
  suffix?: string;
  mono?: boolean;
}) {
  const handle = (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: "var(--bg, #0E0F12)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0 12px",
        height: 40,
      }}
    >
      <input
        value={value}
        onChange={handle}
        onBlur={onBlur}
        type={type}
        placeholder={placeholder}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontSize: 14,
          fontFamily: mono
            ? "ui-monospace, SFMono-Regular, Menlo, monospace"
            : "inherit",
          height: "100%",
        }}
      />
      {suffix && (
        <span style={{ color: "var(--text-3)", fontSize: 12, marginLeft: 8 }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: "100%",
        boxSizing: "border-box",
        background: "var(--bg, #0E0F12)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 12px",
        color: "var(--text)",
        fontSize: 14,
        fontFamily: "inherit",
        resize: "vertical",
        outline: "none",
      }}
    />
  );
}

function PresetPicker({
  value,
  onChange,
}: {
  value: EmissionPreset;
  onChange: (v: EmissionPreset) => void;
}) {
  const keys: EmissionPreset[] = ["flat", "frontloaded", "backloaded", "linear-decay"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {keys.map((k) => {
        const active = value === k;
        return (
          <button
            key={k}
            type="button"
            onClick={() => onChange(k)}
            style={{
              textAlign: "left",
              background: active ? "var(--accent-bg)" : "transparent",
              border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
              color: active ? "var(--accent)" : "var(--text)",
              borderRadius: 10,
              padding: 14,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
              {PRESET_COPY[k].label}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {PRESET_COPY[k].blurb}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Banner({ children, tone }: { children: ReactNode; tone: "warn" | "accent" }) {
  const toneStyle =
    tone === "accent"
      ? {
          background: "var(--accent-bg)",
          border: "1px solid rgba(127,224,194,0.18)",
          color: "var(--accent)",
        }
      : {
          background: "var(--warn-bg, rgba(224,176,98,0.08))",
          border: "1px solid rgba(224,176,98,0.18)",
          color: "var(--warn, #e0b062)",
        };
  return (
    <div
      style={{
        marginTop: 20,
        borderRadius: 10,
        padding: 14,
        fontSize: 13,
        ...toneStyle,
      }}
    >
      {children}
    </div>
  );
}

// ---- utils -----------------------------------------------------------------

function humanDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---- DateTimeInput ---------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function DateTimeInput({
  value,
  onChange,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const selected = useMemo<Date | null>(() => {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }, [value]);

  const [viewDate, setViewDate] = useState<Date>(() => {
    const base = selected ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const vy = viewDate.getFullYear();
  const vm = viewDate.getMonth();

  const timeStr = selected
    ? `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`
    : "00:00";

  const cells = useMemo(() => {
    const firstDow = new Date(vy, vm, 1).getDay();
    const daysInMonth = new Date(vy, vm + 1, 0).getDate();
    const prevDays = new Date(vy, vm, 0).getDate();
    const result: { day: number; offset: -1 | 0 | 1 }[] = [];
    for (let i = 0; i < firstDow; i++)
      result.push({ day: prevDays - firstDow + 1 + i, offset: -1 });
    for (let d = 1; d <= daysInMonth; d++)
      result.push({ day: d, offset: 0 });
    const trailing = (7 - (result.length % 7)) % 7;
    for (let d = 1; d <= trailing; d++)
      result.push({ day: d, offset: 1 });
    return result;
  }, [vy, vm]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        onBlur?.();
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open, onBlur]);

  const openCalendar = () => {
    if (selected) setViewDate(new Date(selected.getFullYear(), selected.getMonth(), 1));
    setOpen((o) => !o);
  };

  const pickDay = (day: number, offset: -1 | 0 | 1) => {
    let y = vy;
    let m = vm + offset;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    const [hh, mm] = timeStr.split(":").map(Number);
    onChange(toDatetimeLocal(new Date(y, m, day, hh, mm)));
    if (offset !== 0) setViewDate(new Date(y, m, 1));
  };

  const pickTime = (t: string) => {
    const base = selected ?? new Date(vy, vm, 1);
    const [hh, mm] = (t || "00:00").split(":").map(Number);
    onChange(toDatetimeLocal(new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh || 0, mm || 0)));
  };

  const prevMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const nextMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));

  const display = selected
    ? `${selected.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}  ${timeStr}`
    : "";

  const now = new Date();
  const navBtn = {
    background: "transparent",
    border: "none",
    color: "var(--text-2)",
    fontSize: 20,
    cursor: "pointer",
    padding: "0 6px",
    lineHeight: 1,
  } as const;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div
        role="button"
        tabIndex={0}
        onClick={openCalendar}
        onKeyDown={(e) => e.key === "Enter" && openCalendar()}
        style={{
          display: "flex",
          alignItems: "center",
          background: "var(--bg)",
          border: `1px solid ${open ? "var(--border-strong)" : "var(--border)"}`,
          borderRadius: 8,
          padding: "0 12px",
          height: 40,
          cursor: "pointer",
          userSelect: "none",
          gap: 8,
        }}
      >
        <span style={{ flex: 1, fontSize: 14, color: display ? "var(--text)" : "var(--text-3)" }}>
          {display || "Select date & time"}
        </span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
          <rect x="1.5" y="3" width="13" height="11.5" rx="1.5" stroke="var(--text-2)" strokeWidth="1.4" />
          <path d="M1.5 6.5h13" stroke="var(--text-2)" strokeWidth="1.4" />
          <path d="M5 1.5v3M11 1.5v3" stroke="var(--text-2)" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 100,
            background: "var(--bg-raised)",
            border: "1px solid var(--border-strong)",
            borderRadius: 12,
            padding: "14px 14px 12px",
            width: 252,
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            animation: "seriFadeIn 0.1s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <button type="button" onClick={prevMonth} style={navBtn}>‹</button>
            <span style={{ flex: 1, textAlign: "center", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
              {MONTH_NAMES[vm]} {vy}
            </span>
            <button type="button" onClick={nextMonth} style={navBtn}>›</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
            {DAY_LABELS.map((l) => (
              <div key={l} style={{ textAlign: "center", fontSize: 10, color: "var(--text-3)", paddingBottom: 6, letterSpacing: "0.05em" }}>
                {l}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1 }}>
            {cells.map((cell, i) => {
              const isCur = cell.offset === 0;
              const isSel =
                isCur &&
                selected !== null &&
                selected.getDate() === cell.day &&
                selected.getMonth() === vm &&
                selected.getFullYear() === vy;
              const isToday =
                isCur &&
                now.getDate() === cell.day &&
                now.getMonth() === vm &&
                now.getFullYear() === vy;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pickDay(cell.day, cell.offset)}
                  style={{
                    height: 28,
                    borderRadius: 5,
                    fontSize: 12,
                    border: isToday && !isSel ? "1px solid var(--border-strong)" : "1px solid transparent",
                    background: isSel ? "var(--accent)" : "transparent",
                    color: isSel ? "#0a0b0e" : isCur ? "var(--text)" : "var(--text-3)",
                    fontWeight: isSel ? 600 : 400,
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-3)", flex: 1 }}>Time</span>
            <input
              type="time"
              value={timeStr}
              onChange={(e) => pickTime(e.target.value)}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "4px 8px",
                color: "var(--text)",
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
                colorScheme: "dark",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

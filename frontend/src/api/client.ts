import type {
  Auction,
  Bid,
  BidBookRow,
  CreateAuctionPayload,
  PricePoint,
  WsEvent,
} from "./types";
import {
  MOCK_AUCTION,
  MOCK_BID_BOOK,
  MOCK_PRICE_HISTORY,
  mockBid,
  type MockBidMode,
} from "./mock";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3002";
const WS_BASE =
  (import.meta.env.VITE_WS_BASE as string | undefined) ?? "ws://localhost:3002/ws";

async function tryFetch<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchAuction(address: string): Promise<Auction> {
  const got = await tryFetch<Auction>(`/api/auctions/${address}`);
  return got ?? { ...MOCK_AUCTION, address };
}

export async function fetchAuctions(params?: {
  status?: string;
  creator?: string;
}): Promise<Auction[] | null> {
  const q = new URLSearchParams();
  if (params?.status) q.set("status", params.status);
  if (params?.creator) q.set("creator", params.creator);
  const qs = q.toString();
  return tryFetch<Auction[]>(`/api/auctions${qs ? `?${qs}` : ""}`);
}

export async function fetchAuctionBids(address: string): Promise<Bid[] | null> {
  return tryFetch<Bid[]>(`/api/auctions/${address}/bids`);
}

export async function fetchUserAuctions(wallet: string): Promise<Auction[] | null> {
  return tryFetch<Auction[]>(`/api/users/${wallet}/auctions`);
}

export async function connectWallet(wallet: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/users/${wallet}/connect`, { method: "POST" });
  } catch {
    /* backend optional */
  }
}

export interface BuildBidTxResponse {
  tx: string; // base64-encoded unsigned legacy Transaction
  bidPda: string;
  now: number;
}

export async function buildBidTx(
  auction: string,
  body: { bidder: string; maxPrice: string; amount: string }
): Promise<BuildBidTxResponse> {
  const r = await fetch(`${API_BASE}/api/auctions/${auction}/bid/build-tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "build-tx failed");
    throw new Error(msg || `build-tx failed (${r.status})`);
  }
  return (await r.json()) as BuildBidTxResponse;
}

export interface BuildExitTxResponse {
  tx: string;
  flow: string;
}

export async function buildExitTx(
  auction: string,
  bid: string,
  body: { bidder: string }
): Promise<BuildExitTxResponse> {
  const r = await fetch(
    `${API_BASE}/api/auctions/${auction}/bid/${bid}/exit-tx`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) {
    const msg = await r.text().catch(() => "exit-tx failed");
    throw new Error(msg || `exit-tx failed (${r.status})`);
  }
  return (await r.json()) as BuildExitTxResponse;
}

export interface BuildClaimTxResponse {
  tx: string;
}

export async function buildClaimTx(
  auction: string,
  bid: string,
  body: { bidder: string }
): Promise<BuildClaimTxResponse> {
  const r = await fetch(
    `${API_BASE}/api/auctions/${auction}/bid/${bid}/claim-tx`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) {
    const msg = await r.text().catch(() => "claim-tx failed");
    throw new Error(msg || `claim-tx failed (${r.status})`);
  }
  return (await r.json()) as BuildClaimTxResponse;
}

export interface BuildInitTxResponse {
  tx: string; // base64-encoded unsigned transaction
  auctionPda: string; // derived auction PDA (for redirects)
  tokenVault: string;
  currencyVault: string;
  creatorTokenAccount: string;
}

export async function buildInitTx(
  payload: CreateAuctionPayload
): Promise<BuildInitTxResponse> {
  const r = await fetch(`${API_BASE}/api/auctions/build-init-tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "build-init-tx failed");
    throw new Error(msg || `build-init-tx failed (${r.status})`);
  }
  return (await r.json()) as BuildInitTxResponse;
}

export interface AuctionMetadataBody {
  token_name?: string;
  token_symbol?: string;
  token_tagline?: string;
  token_icon_url?: string;
  description?: string;
}

export async function setAuctionMetadata(
  address: string,
  body: AuctionMetadataBody
): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/auctions/${address}/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function persistAuctionMetadata(
  address: string,
  body: AuctionMetadataBody,
  options?: { attempts?: number; delayMs?: number }
): Promise<boolean> {
  const attempts = options?.attempts ?? 15;
  const delayMs = options?.delayMs ?? 1000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await setAuctionMetadata(address, body)) return true;
    if (attempt < attempts - 1) {
      await wait(delayMs);
    }
  }
  return false;
}

export async function fetchPriceHistory(address: string): Promise<PricePoint[]> {
  const got = await tryFetch<PricePoint[]>(`/api/auctions/${address}/price-history`);
  return got ?? MOCK_PRICE_HISTORY;
}

export async function fetchBidBook(address: string): Promise<BidBookRow[]> {
  const got = await tryFetch<BidBookRow[]>(`/api/auctions/${address}/bid-book`);
  return got ?? MOCK_BID_BOOK;
}

export async function fetchUserBid(
  wallet: string | null,
  auction: string,
  fallback: MockBidMode = "active"
): Promise<Bid | null> {
  if (!wallet) return mockBid(fallback);
  const bids = await tryFetch<Bid[]>(`/api/users/${wallet}/bids`);
  if (!bids) return mockBid(fallback);
  return bids.find((b) => b.auction === auction) ?? null;
}

// --- websocket ---

export type WsHandle = { close: () => void };

export function subscribeAuction(
  address: string,
  onEvent: (e: WsEvent) => void
): WsHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  try {
    ws = new WebSocket(WS_BASE);
    ws.addEventListener("open", () => {
      ws?.send(JSON.stringify({ type: "subscribe", auctions: [address] }));
    });
    ws.addEventListener("message", (e) => {
      try {
        const parsed = JSON.parse(e.data) as WsEvent;
        onEvent(parsed);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("error", () => {
      /* silent — backend may not be up yet */
    });
  } catch {
    /* websocket unavailable in this env */
  }
  return {
    close: () => {
      if (closed) return;
      closed = true;
      ws?.close();
    },
  };
}

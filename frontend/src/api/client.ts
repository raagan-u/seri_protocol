import type { Auction, Bid, BidBookRow, PricePoint, WsEvent } from "./types";
import {
  MOCK_AUCTION,
  MOCK_BID_BOOK,
  MOCK_PRICE_HISTORY,
  mockBid,
  type MockBidMode,
} from "./mock";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3001";
const WS_BASE =
  (import.meta.env.VITE_WS_BASE as string | undefined) ?? "ws://localhost:3001/ws";

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

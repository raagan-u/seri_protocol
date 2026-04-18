//! WebSocket hub: broadcasts indexer events to subscribed clients.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tokio::sync::broadcast;

pub type WsSender = broadcast::Sender<WsEvent>;

pub fn new_channel() -> WsSender {
    let (tx, _rx) = broadcast::channel(256);
    tx
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    PriceUpdate {
        auction: String,
        #[serde(rename = "clearingPrice")]
        clearing_price: String,
        timestamp: i64,
    },
    NewBid {
        auction: String,
        #[serde(rename = "bidId")]
        bid_id: i64,
        #[serde(rename = "bidCount")]
        bid_count: i64,
    },
    StateChange {
        auction: String,
        status: String,
    },
    Checkpoint {
        auction: String,
        #[serde(rename = "clearingPrice")]
        clearing_price: String,
        #[serde(rename = "currencyRaised")]
        currency_raised: String,
        #[serde(rename = "supplyReleasedPercent")]
        supply_released_percent: f64,
    },
}

impl WsEvent {
    pub fn auction(&self) -> &str {
        match self {
            WsEvent::PriceUpdate { auction, .. }
            | WsEvent::NewBid { auction, .. }
            | WsEvent::StateChange { auction, .. }
            | WsEvent::Checkpoint { auction, .. } => auction,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Subscribe { auctions: Vec<String> },
    Unsubscribe { auctions: Vec<String> },
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(tx): State<WsSender>,
) -> Response {
    ws.on_upgrade(move |socket| client_loop(socket, tx))
}

async fn client_loop(mut socket: WebSocket, tx: WsSender) {
    let mut rx = tx.subscribe();
    let mut subs: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            msg = socket.recv() => {
                let Some(Ok(m)) = msg else { break };
                match m {
                    Message::Text(t) => {
                        if let Ok(parsed) = serde_json::from_str::<ClientMsg>(&t) {
                            match parsed {
                                ClientMsg::Subscribe { auctions } => subs.extend(auctions),
                                ClientMsg::Unsubscribe { auctions } => {
                                    for a in auctions { subs.remove(&a); }
                                }
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            evt = rx.recv() => {
                let Ok(evt) = evt else { continue };
                if !subs.contains(evt.auction()) { continue; }
                let Ok(json) = serde_json::to_string(&evt) else { continue };
                if socket.send(Message::Text(json)).await.is_err() { break; }
            }
        }
    }
}

//! Minimal Solana JSON-RPC client — just enough for getProgramAccounts.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct RpcClient {
    http: reqwest::Client,
    url: String,
}

#[derive(Debug, Clone)]
pub struct ProgramAccount {
    pub pubkey: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct TokenAccountInfo {
    pub pubkey: String,
    pub amount: u64,
}

#[derive(Debug, Deserialize)]
struct RpcResp {
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
}

impl RpcClient {
    pub fn new(url: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            url,
        }
    }

    /// Fetch all accounts owned by program_id whose first 8 bytes match `disc`.
    pub async fn get_program_accounts_with_disc(
        &self,
        program_id: &str,
        disc: &[u8; 8],
    ) -> anyhow::Result<Vec<ProgramAccount>> {
        let disc_b58 = bs58::encode(disc).into_string();
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getProgramAccounts",
            "params": [
                program_id,
                {
                    "encoding": "base64",
                    "filters": [
                        { "memcmp": { "offset": 0, "bytes": disc_b58 } }
                    ]
                }
            ]
        });

        let resp: RpcResp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        if let Some(err) = resp.error {
            anyhow::bail!("rpc error: {err}");
        }
        let arr = resp.result.unwrap_or(Value::Null);
        let items = arr.as_array().cloned().unwrap_or_default();

        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let pubkey = item
                .get("pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let data_arr = item
                .get("account")
                .and_then(|a| a.get("data"))
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let b64 = data_arr.first().and_then(|v| v.as_str()).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap_or_default();
            if !pubkey.is_empty() && !bytes.is_empty() {
                out.push(ProgramAccount {
                    pubkey,
                    data: bytes,
                });
            }
        }
        Ok(out)
    }

    pub async fn get_slot(&self) -> anyhow::Result<u64> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSlot",
            "params": [{ "commitment": "confirmed" }]
        });
        let resp: RpcResp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            anyhow::bail!("rpc error: {err}");
        }
        resp.result
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow::anyhow!("missing slot in getSlot response"))
    }

    pub async fn get_latest_blockhash(&self) -> anyhow::Result<String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getLatestBlockhash",
            "params": [{ "commitment": "confirmed" }]
        });
        let resp: RpcResp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            anyhow::bail!("rpc error: {err}");
        }
        let bh = resp
            .result
            .and_then(|r| r.get("value").cloned())
            .and_then(|v| v.get("blockhash").cloned())
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or_else(|| anyhow::anyhow!("missing blockhash"))?;
        Ok(bh)
    }

    pub async fn send_transaction(&self, tx_bytes: &[u8]) -> anyhow::Result<String> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(tx_bytes);
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [b64, { "encoding": "base64", "skipPreflight": false, "preflightCommitment": "processed" }]
        });
        let resp: RpcResp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            anyhow::bail!("sendTransaction error: {err}");
        }
        let sig = resp
            .result
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or_else(|| anyhow::anyhow!("missing signature in sendTransaction response"))?;
        Ok(sig)
    }

    pub async fn get_account(&self, pubkey: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAccountInfo",
            "params": [pubkey, { "encoding": "base64", "commitment": "confirmed" }]
        });
        let resp: RpcResp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            anyhow::bail!("rpc error: {err}");
        }
        let val = resp.result.and_then(|r| r.get("value").cloned());
        if val.as_ref().map(|v| v.is_null()).unwrap_or(true) {
            return Ok(None);
        }
        let data_arr = val
            .unwrap()
            .get("data")
            .and_then(|d| d.as_array().cloned())
            .unwrap_or_default();
        let b64 = data_arr.first().and_then(|v| v.as_str()).unwrap_or("");
        Ok(Some(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap_or_default(),
        ))
    }

    pub async fn get_token_accounts_by_owner_and_mint(
        &self,
        owner: &str,
        mint: &str,
    ) -> anyhow::Result<Vec<TokenAccountInfo>> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTokenAccountsByOwner",
            "params": [
                owner,
                { "mint": mint },
                { "encoding": "base64", "commitment": "confirmed" }
            ]
        });
        let resp: RpcResp = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            anyhow::bail!("rpc error: {err}");
        }
        let items = resp
            .result
            .and_then(|r| r.get("value").cloned())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();

        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let pubkey = item
                .get("pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let data_arr = item
                .get("account")
                .and_then(|a| a.get("data"))
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            let b64 = data_arr.first().and_then(|v| v.as_str()).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap_or_default();
            if pubkey.is_empty() || bytes.len() < 72 {
                continue;
            }
            let mut amount_bytes = [0u8; 8];
            amount_bytes.copy_from_slice(&bytes[64..72]);
            out.push(TokenAccountInfo {
                pubkey,
                amount: u64::from_le_bytes(amount_bytes),
            });
        }
        Ok(out)
    }
}

use napi::bindgen_prelude::*;
use napi_derive::napi;
use reqwest::Client;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use serde_json::Value;

// --- BINANCE LISTENER IMPORTS ---
use fast_websocket_client::{connect, OpCode};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use serde::Deserialize;
use tokio::time::sleep;

type HmacSha256 = Hmac<Sha256>;

// ==========================================
// 1. DELTA EXCHANGE NATIVE REST CLIENT
// ==========================================

#[napi]
pub struct DeltaNativeClient {
  api_key: String,
  api_secret: String,
  base_url: String,
  client: Client,
}

#[napi]
impl DeltaNativeClient {
  
  #[napi(constructor)]
  pub fn new(api_key: String, api_secret: String, base_url: Option<String>) -> Result<Self> {
    let url = base_url.unwrap_or_else(|| "https://api.india.delta.exchange".to_string());
    
    let client = Client::builder()
        .tcp_nodelay(true) 
        .pool_idle_timeout(None) 
        .pool_max_idle_per_host(10)
        .connect_timeout(Duration::from_millis(2500))
        .timeout(Duration::from_millis(2500))
        .user_agent("Mozilla/5.0 (compatible; DeltaBot/Native)")
        .build()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Client build failed: {}", e)))?;

    Ok(DeltaNativeClient {
      api_key,
      api_secret,
      base_url: url,
      client,
    })
  }

  fn sign(&self, method: &str, path: &str, query: &str, body: &str, timestamp: &str) -> Result<String> {
    let signature_data = format!("{}{}{}{}{}", method, timestamp, path, query, body);
    
    let mut mac = HmacSha256::new_from_slice(self.api_secret.as_bytes())
        .map_err(|_| Error::new(Status::GenericFailure, "Invalid API Secret"))?;
        
    mac.update(signature_data.as_bytes());
    let result = mac.finalize();
    Ok(hex::encode(result.into_bytes()))
  }

  #[napi]
  pub async fn place_order(&self, body: Value) -> Result<Value> {
    let path = "/v2/orders";
    let method = "POST";
    let body_str = body.to_string();
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    let signature = self.sign(method, path, "", &body_str, &timestamp)?;

    let res = self.client
        .post(format!("{}{}", self.base_url, path))
        .header("api-key", &self.api_key)
        .header("timestamp", &timestamp)
        .header("signature", &signature)
        .header("Content-Type", "application/json")
        .body(body_str)
        .send()
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Request failed: {}", e)))?;

    let json: Value = res.json().await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Parse failed: {}", e)))?;
        
    Ok(json)
  }

  #[napi]
  pub async fn get_wallet_balance(&self) -> Result<Value> {
    let path = "/v2/wallet/balances";
    let method = "GET";
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    let signature = self.sign(method, path, "", "", &timestamp)?;

    let res = self.client
        .get(format!("{}{}", self.base_url, path))
        .header("api-key", &self.api_key)
        .header("timestamp", &timestamp)
        .header("signature", &signature)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Request failed: {}", e)))?;

     let json: Value = res.json().await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Parse failed: {}", e)))?;

     Ok(json)
  }

  #[napi]
  pub async fn get_positions(&self) -> Result<Value> {
    let path = "/v2/positions/margined";
    let method = "GET";
    
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    let signature = self.sign(method, path, "", "", &timestamp)?;

    let res = self.client
        .get(format!("{}{}", self.base_url, path))
        .header("api-key", &self.api_key)
        .header("timestamp", &timestamp)
        .header("signature", &signature)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Request failed: {}", e)))?;

     let json: Value = res.json().await
        .map_err(|e| Error::new(Status::GenericFailure, format!("Parse failed: {}", e)))?;

     Ok(json)
  }
}

// ==========================================
// 2. BINANCE DEPTH (bookTicker) LISTENER
// ==========================================

#[napi(object)]
pub struct DepthUpdate {
    pub s: String,
    pub bb: f64,
    pub bq: f64,
    pub ba: f64,
    pub aq: f64,
}

#[derive(Deserialize, Debug)]
struct BinanceDepthMsg {
    data: Option<BinanceDepthData>,
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct BinanceDepthData {
    s: String, 
    b: String, 
    B: String, 
    a: String, 
    A: String, 
}

#[napi]
pub struct BinanceListener {}

#[napi]
impl BinanceListener {
    #[napi(constructor)]
    pub fn new() -> Self {
        BinanceListener {}
    }

    #[napi]
    pub fn start(&self, assets: Vec<String>, callback: ThreadsafeFunction<DepthUpdate>) -> Result<()> {
        let streams = assets
            .iter()
            .map(|a| format!("{}usdt@bookTicker", a.to_lowercase()))
            .collect::<Vec<_>>()
            .join("/");

        let url = format!("wss://fstream.binance.com/stream?streams={}", streams);

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();

            rt.block_on(async move {
                loop {
                    println!("[Rust-Depth] ⚡ Connecting to Binance bookTicker...");

                    match connect(&url).await {
                        Ok(mut client) => {
                            println!("[Rust-Depth] ✅ Connected & Streaming.");
                            let mut scratch_buffer: Vec<u8> = Vec::with_capacity(1024);

                            loop {
                                match client.receive_frame().await {
                                    Ok(frame) => {
                                        if frame.opcode == OpCode::Text {
                                            scratch_buffer.clear();
                                            scratch_buffer.extend_from_slice(&frame.payload);

                                            if let Ok(parsed) = simd_json::from_slice::<BinanceDepthMsg>(&mut scratch_buffer) {
                                                if let Some(data) = parsed.data {
                                                    let asset_name = data.s.replace("USDT", "");
                                                    
                                                    let update = DepthUpdate {
                                                        s: asset_name,
                                                        bb: data.b.parse::<f64>().unwrap_or(0.0),
                                                        bq: data.B.parse::<f64>().unwrap_or(0.0),
                                                        ba: data.a.parse::<f64>().unwrap_or(0.0),
                                                        aq: data.A.parse::<f64>().unwrap_or(0.0),
                                                    };

                                                    callback.call(Ok(update), ThreadsafeFunctionCallMode::NonBlocking);
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        println!("[Rust-Depth] ⚠️ Error: {:?}", e);
                                        break; 
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            println!("[Rust-Depth] ❌ Failed: {}. Retrying in 5s...", e);
                        }
                    }
                    sleep(Duration::from_secs(5)).await;
                }
            });
        });

        Ok(())
    }
}

// ==========================================
// 3. BINANCE TRADES LISTENER (NEW)
// ==========================================

#[napi(object)]
pub struct TradeUpdate {
    pub s: String,   // Symbol (e.g., "XRP")
    pub p: f64,      // Trade price
    pub q: f64,      // Trade quantity
    pub t: i64,      // Trade ID
    pub ts: i64,     // Trade time (ms)
    pub m: bool,     // Is buyer maker
}

#[derive(Deserialize, Debug)]
struct BinanceTradeMsg {
    #[serde(rename = "e")]
    event: Option<String>,
    #[serde(rename = "s")]
    symbol: Option<String>,
    #[serde(rename = "p")]
    price: Option<String>,
    #[serde(rename = "q")]
    quantity: Option<String>,
    #[serde(rename = "t")]
    trade_id: Option<i64>,
    #[serde(rename = "T")]
    trade_time: Option<i64>,
    #[serde(rename = "m")]
    buyer_maker: Option<bool>,
}

#[napi]
pub struct BinanceTradeListener {}

#[napi]
impl BinanceTradeListener {
    #[napi(constructor)]
    pub fn new() -> Self {
        BinanceTradeListener {}
    }

    #[napi]
    pub fn start(&self, assets: Vec<String>, callback: ThreadsafeFunction<TradeUpdate>) -> Result<()> {
        let streams = assets
            .iter()
            .map(|a| format!("{}usdt@trade", a.to_lowercase()))
            .collect::<Vec<_>>()
            .join("/");

        let url = format!("wss://fstream.binance.com/stream?streams={}", streams);

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();

            rt.block_on(async move {
                loop {
                    println!("[Rust-Trades] ⚡ Connecting to Binance @trade...");

                    match connect(&url).await {
                        Ok(mut client) => {
                            println!("[Rust-Trades] ✅ Connected & Streaming.");
                            let mut scratch_buffer: Vec<u8> = Vec::with_capacity(1024);

                            loop {
                                match client.receive_frame().await {
                                    Ok(frame) => {
                                        if frame.opcode == OpCode::Text {
                                            scratch_buffer.clear();
                                            scratch_buffer.extend_from_slice(&frame.payload);

                                            if let Ok(parsed) = simd_json::from_slice::<BinanceTradeMsg>(&mut scratch_buffer) {
                                                if let (Some(symbol), Some(price)) = (parsed.symbol, parsed.price) {
                                                    let asset_name = symbol.replace("USDT", "");
                                                    
                                                    let update = TradeUpdate {
                                                        s: asset_name,
                                                        p: price.parse::<f64>().unwrap_or(0.0),
                                                        q: parsed.quantity.unwrap_or_default().parse::<f64>().unwrap_or(0.0),
                                                        t: parsed.trade_id.unwrap_or(0),
                                                        ts: parsed.trade_time.unwrap_or(0),
                                                        m: parsed.buyer_maker.unwrap_or(false),
                                                    };

                                                    callback.call(Ok(update), ThreadsafeFunctionCallMode::NonBlocking);
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        println!("[Rust-Trades] ⚠️ Error: {:?}", e);
                                        break; 
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            println!("[Rust-Trades] ❌ Failed: {}. Retrying in 5s...", e);
                        }
                    }
                    sleep(Duration::from_secs(5)).await;
                }
            });
        });

        Ok(())
    }
}

use napi::bindgen_prelude::*;
use napi_derive::napi;
use reqwest::Client; // [FIX] Removed unused 'header'
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use serde_json::Value;

type HmacSha256 = Hmac<Sha256>;

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
    
    // [FIX] Added Timeouts for Safety
    let client = Client::builder()
        .tcp_nodelay(true) 
        .pool_idle_timeout(None) 
        .pool_max_idle_per_host(10)
        .connect_timeout(Duration::from_secs(5)) // Fail fast if Delta is down
        .timeout(Duration::from_secs(5))         // Fail fast if request hangs
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

  // [FIX] Added 'query' support to signature generation
  fn sign(&self, method: &str, path: &str, query: &str, body: &str, timestamp: &str) -> Result<String> {
    // Delta expects: method + timestamp + path + query_string + body
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
  

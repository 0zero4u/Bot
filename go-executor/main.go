package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

var (
	apiKey    string
	apiSecret string
	client    *http.Client
)

type OrderRequest struct {
	ProductID string `json:"product_id"`
	Size      string `json:"size"`
	Side      string `json:"side"`
	OrderType string `json:"order_type"`
	TrailAmt  string `json:"trail_amount,omitempty"`
	Trigger   string `json:"stop_trigger_method,omitempty"`
	ClientOID string `json:"client_order_id"`
}

type OrderResponse struct {
	Success bool            `json:"success"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

func init() {
	apiKey = os.Getenv("DELTA_API_KEY")
	apiSecret = os.Getenv("DELTA_API_SECRET")

	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		MaxConnsPerHost:     100,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		ForceAttemptHTTP2:   true,
	}

	client = &http.Client{
		Transport: transport,
		Timeout:   5 * time.Second,
	}

	log.Printf("[Go-Executor] Initialized | HTTP/2: true | Pool: 100")
}

func sign(method, timestamp, path, body string) string {
	data := method + timestamp + path + body
	mac := hmac.New(sha256.New, []byte(apiSecret))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

func placeOrder(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	var req OrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	body, _ := json.Marshal(req)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	path := "/v2/orders"
	sig := sign("POST", timestamp, path, string(body))

	httpReq, _ := http.NewRequest("POST", "https://api.india.delta.exchange"+path, bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("api-key", apiKey)
	httpReq.Header.Set("timestamp", timestamp)
	httpReq.Header.Set("signature", sig)

	resp, err := client.Do(httpReq)
	if err != nil {
		elapsed := time.Since(start).Milliseconds()
		log.Printf("[Go-Executor] ERROR: %v | %dms", err, elapsed)
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	elapsed := time.Since(start).Milliseconds()
	log.Printf("[Go-Executor] %s %s %s | %dms", req.Side, req.Size, req.ProductID, elapsed)

	w.Header().Set("Content-Type", "application/json")
	w.Write(respBody)
}

func health(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}

	http.HandleFunc("/order", placeOrder)
	http.HandleFunc("/health", health)

	log.Printf("[Go-Executor] Listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

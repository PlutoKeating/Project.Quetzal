// SPDX-License-Identifier: AGPL-3.0-only

package lease_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"quetzalcoatl-hub/internal/lease"
	"quetzalcoatl-hub/internal/store"
)

// hpkeVectorFile 复刻 spec/vectors/hpke_xwing.json 中 Webhook 入站所需的字段。
// 运行时映射关系：
//   - kem.xwing_pk_hex          -> Agent 的 ChannelIngressKey 公钥（key_slots.slot_type=channel_ingress）
//   - kem.encap_seed_64_hex     -> 仅测试注入的确定性封装种子（生产使用 CSPRNG）
//   - seal_cases[hub_webhook_zero_knowledge_ingress_v2].info_utf8
//     -> auth.WEBHOOK_INGRESS_INFO 常量
//   - seal_cases[...].aad_utf8  -> 规范化 AAD {agent_id,channel,received_at_ms} 的 json.Marshal 输出
//   - seal_cases[...].ciphertext_hex -> 平台明文被 HPKE 密封后的密文
type hpkeVectorFile struct {
	KEM struct {
		EncapSeed64Hex string `json:"encap_seed_64_hex"`
		XWingEncHex    string `json:"xwing_enc_hex"`
		XWingPKHex     string `json:"xwing_pk_hex"`
	} `json:"kem"`
	SealCases []struct {
		ID            string `json:"id"`
		AADUTF8       string `json:"aad_utf8"`
		CiphertextHex string `json:"ciphertext_hex"`
		InfoUTF8      string `json:"info_utf8"`
		PlaintextHex  string `json:"plaintext_hex"`
	} `json:"seal_cases"`
}

func locateRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for dir := wd; ; dir = filepath.Dir(dir) {
		if _, statErr := os.Stat(filepath.Join(dir, "go.work")); statErr == nil {
			return dir
		}
		if _, statErr := os.Stat(filepath.Join(dir, "spec", "vectors", "hpke_xwing.json")); statErr == nil {
			return dir
		}
		if dir == filepath.Dir(dir) {
			t.Fatalf("could not locate repo root from %s", wd)
		}
	}
}

func loadWebhookVector(t *testing.T) hpkeVectorFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(locateRepoRoot(t), "spec", "vectors", "hpke_xwing.json"))
	if err != nil {
		t.Fatalf("read vector: %v", err)
	}
	var v hpkeVectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal vector: %v", err)
	}
	for _, sc := range v.SealCases {
		if sc.ID == "hub_webhook_zero_knowledge_ingress_v2" {
			return v
		}
	}
	t.Fatalf("vector missing hub_webhook_zero_knowledge_ingress_v2 case")
	return v
}

func webhookCase(t *testing.T, v hpkeVectorFile) (aad, ctHex, ptHex string) {
	t.Helper()
	for _, sc := range v.SealCases {
		if sc.ID == "hub_webhook_zero_knowledge_ingress_v2" {
			return sc.AADUTF8, sc.CiphertextHex, sc.PlaintextHex
		}
	}
	t.Fatalf("case missing")
	return "", "", ""
}

const (
	vecAgentID = "018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f"
	vecEpochMs = int64(1_795_400_000_000)
)

type webhookHarness struct {
	srv    *httptest.Server
	st     *store.SQLiteStore
	dbPath string
	secret []byte
}

func newWebhookHarness(t *testing.T, queueLimit int) *webhookHarness {
	t.Helper()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "hub.sqlite")
	st, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	ctx := context.Background()
	if err := st.CreateAccount(ctx, store.Account{AccountID: "acct-webhook", CreatedAtMs: vecEpochMs}); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if err := st.CreateAgent(ctx, store.Agent{
		AgentID:             vecAgentID,
		OwnerAccountID:      "acct-webhook",
		RootVerifyingKeyHex: hex.EncodeToString(bytes.Repeat([]byte{0x11}, 32)),
		QuotaBytes:          1 << 20,
		CreatedAtMs:         vecEpochMs,
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := st.UpsertDevice(ctx, store.Device{
		AgentID:          vecAgentID,
		DeviceID:         "dev-v",
		AccountID:        "acct-webhook",
		Ed25519PubKeyHex: hex.EncodeToString(bytes.Repeat([]byte{0x22}, 32)),
		XWingPubKeyHex:   hex.EncodeToString(bytes.Repeat([]byte{0x33}, 1216)),
		CreatedAtMs:      vecEpochMs,
	}); err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}

	secret := []byte("synthetic-webhook-hmac-secret-998877")
	clk := func() time.Time { return time.UnixMilli(vecEpochMs) }
	svc, err := lease.NewWebhookIngressService(st, lease.WebhookIngressConfig{
		Secrets:           map[string][]byte{"feishu": secret},
		MaxBodyBytes:      64 * 1024,
		MaxQueuePerAgent:  queueLimit,
		DeterministicSeed: mustHex(t, "171a1d202326292c2f3235383b3e4144474a4d505356595c5f6265686b6e7174777a7d808386898c8f9295989b9ea1a4a7aaadb0b3b6b9bcbfc2c5c8cbced1d4"),
	}, clk)
	if err != nil {
		t.Fatalf("NewWebhookIngressService: %v", err)
	}

	mux := http.NewServeMux()
	svc.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &webhookHarness{srv: srv, st: st, dbPath: dbPath, secret: secret}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("decode hex: %v", err)
	}
	return b
}

func signWebhook(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func (h *webhookHarness) post(t *testing.T, agentID, channel string, body []byte, signature string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.srv.URL+"/v1/webhook/"+agentID+"/"+channel, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if signature != "" {
		req.Header.Set("X-QZ-Signature", signature)
	}
	resp, err := h.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()
	var out bytes.Buffer
	if _, err := out.ReadFrom(resp.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, out.Bytes()
}

func TestWebhookIngressHPKEVectorByteExactAndZeroPlaintextCanary(t *testing.T) {
	v := loadWebhookVector(t)
	aad, wantCT, ptHex := webhookCase(t, v)
	pt := mustHex(t, ptHex)

	h := newWebhookHarness(t, 64)
	// 注入向量对应的 ChannelIngressKey（X-Wing 公钥是公开值，可安全存放于 key_slots）。
	if err := h.st.UpsertKeySlot(context.Background(), store.KeySlotEnvelope{
		AgentID:       vecAgentID,
		Slot:          lease.ChannelIngressSlotType + ":dev-v",
		AADUTF8:       `{"purpose":"channel-ingress"}`,
		NonceHex:      "",
		CiphertextHex: v.KEM.XWingPKHex,
		UpdatedAtMs:   vecEpochMs,
	}); err != nil {
		t.Fatalf("UpsertKeySlot: %v", err)
	}

	resp, raw := h.post(t, vecAgentID, "feishu", pt, signWebhook(h.secret, pt))
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST webhook status=%d body=%s", resp.StatusCode, raw)
	}

	var encHex, ctHex, storedAAD string
	row := h.st.DBForTest().QueryRow(
		`SELECT hpke_enc_hex, ciphertext_hex, aad_utf8 FROM webhook_ingress_queue WHERE agent_id = ?`,
		vecAgentID,
	)
	if err := row.Scan(&encHex, &ctHex, &storedAAD); err != nil {
		t.Fatalf("read queued ingress: %v", err)
	}
	if storedAAD != aad {
		t.Fatalf("AAD mismatch:\n got: %s\nwant: %s", storedAAD, aad)
	}
	if ctHex != wantCT {
		t.Fatalf("HPKE ciphertext mismatch:\n got: %s\nwant: %s", ctHex, wantCT)
	}
	if encHex != v.KEM.XWingEncHex {
		t.Fatalf("HPKE enc mismatch")
	}

	// 零明文落盘 canary：正文与明文字段绝不能出现在 SQLite 主库或 WAL。
	for _, path := range []string{h.dbPath, h.dbPath + "-wal"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, canary := range [][]byte{pt, []byte(`请整理今日会诊纪要`), []byte("ev_9910")} {
			if bytes.Contains(data, canary) {
				t.Fatalf("ZERO-KNOWLEDGE VIOLATION: plaintext %q found in %s", canary, filepath.Base(path))
			}
		}
	}

	// schema allowlist：队列表只允许密文/封装/AAD/元数据列，绝不出现 body/text/plaintext 列。
	rows, err := h.st.DBForTest().Query(`PRAGMA table_info(webhook_ingress_queue)`)
	if err != nil {
		t.Fatalf("PRAGMA table_info: %v", err)
	}
	defer rows.Close()
	allowed := map[string]bool{
		"ingress_id": true, "agent_id": true, "channel": true, "event_id_hash": true, "target_device_id": true,
		"hpke_enc_hex": true, "ciphertext_hex": true, "aad_utf8": true,
		"received_at_ms": true, "created_at_ms": true,
	}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			t.Fatalf("scan table_info: %v", err)
		}
		if !allowed[name] {
			t.Fatalf("schema allowlist violation: unexpected column %q", name)
		}
	}
}

func TestWebhookIngressRejectsUnknownBadHMACOversizeAndDeduplicates(t *testing.T) {
	v := loadWebhookVector(t)
	_, _, ptHex := webhookCase(t, v)
	pt := mustHex(t, ptHex)

	h := newWebhookHarness(t, 2)
	if err := h.st.UpsertKeySlot(context.Background(), store.KeySlotEnvelope{
		AgentID:       vecAgentID,
		Slot:          lease.ChannelIngressSlotType + ":dev-v",
		AADUTF8:       `{"purpose":"channel-ingress"}`,
		CiphertextHex: v.KEM.XWingPKHex,
		UpdatedAtMs:   vecEpochMs,
	}); err != nil {
		t.Fatalf("UpsertKeySlot: %v", err)
	}

	sig := signWebhook(h.secret, pt)
	if resp, _ := h.post(t, vecAgentID, "feishu", pt, "sha256=deadbeef"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad HMAC expected 401, got %d", resp.StatusCode)
	}
	if resp, _ := h.post(t, "99999999-0000-4000-8000-000000000000", "feishu", pt, sig); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown agent expected 404, got %d", resp.StatusCode)
	}
	if resp, _ := h.post(t, vecAgentID, "feishu", append(pt, bytes.Repeat([]byte{'x'}, 70*1024)...), sig); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body expected 413, got %d", resp.StatusCode)
	}

	// 首次接收成功，重复 event_id 必须幂等去重（仍为 202，但队列长度保持 1）。
	if resp, raw := h.post(t, vecAgentID, "feishu", pt, sig); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("first delivery status=%d body=%s", resp.StatusCode, raw)
	}
	if resp, raw := h.post(t, vecAgentID, "feishu", pt, sig); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("duplicate delivery status=%d body=%s", resp.StatusCode, raw)
	}
	var depth int
	if err := h.st.DBForTest().QueryRow(`SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = ?`, vecAgentID).Scan(&depth); err != nil {
		t.Fatalf("count queue: %v", err)
	}
	if depth != 1 {
		t.Fatalf("duplicate event_id must be deduplicated, depth=%d", depth)
	}

	// 队列上限：新 event_id 超过上限返回 429，且绝不落盘。
	for i := 0; i < 2; i++ {
		body := []byte(fmt.Sprintf(`{"event_id":"ev_extra_%d","sender":"ou_synthetic","text":"x"}`, i))
		resp, raw := h.post(t, vecAgentID, "feishu", body, signWebhook(h.secret, body))
		want := http.StatusAccepted
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if resp.StatusCode != want {
			t.Fatalf("queue bound request %d status=%d want=%d body=%s", i, resp.StatusCode, want, raw)
		}
	}
}

func TestWebhookIngressMissingIngressKeyFailClosed(t *testing.T) {
	v := loadWebhookVector(t)
	_, _, ptHex := webhookCase(t, v)
	pt := mustHex(t, ptHex)

	h := newWebhookHarness(t, 8)
	resp, raw := h.post(t, vecAgentID, "feishu", pt, signWebhook(h.secret, pt))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("missing ingress key must fail closed with 409, got %d (%s)", resp.StatusCode, raw)
	}
}

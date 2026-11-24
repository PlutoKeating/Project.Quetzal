// SPDX-License-Identifier: AGPL-3.0-only

package lease_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/lease"
	"quetzalcoatl-hub/internal/store"
)

func seedSession(t *testing.T, st *store.SQLiteStore, accountID, agentID, deviceID, token string, nowMs int64) {
	t.Helper()
	ctx := context.Background()
	if err := st.CreateAccount(ctx, store.Account{AccountID: accountID, CreatedAtMs: nowMs}); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if err := st.CreateAgent(ctx, store.Agent{
		AgentID:             agentID,
		OwnerAccountID:      accountID,
		RootVerifyingKeyHex: hex.EncodeToString(bytes.Repeat([]byte{0x11}, 32)),
		QuotaBytes:          1 << 20,
		CreatedAtMs:         nowMs,
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := st.UpsertDevice(ctx, store.Device{
		AgentID:          agentID,
		DeviceID:         deviceID,
		AccountID:        accountID,
		Ed25519PubKeyHex: hex.EncodeToString(bytes.Repeat([]byte{0x22}, 32)),
		XWingPubKeyHex:   hex.EncodeToString(bytes.Repeat([]byte{0x33}, 1216)),
		CreatedAtMs:      nowMs,
	}); err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}
	sum := sha256.Sum256([]byte(token))
	if err := st.CreateSession(ctx, store.Session{
		TokenSHA256Hex: hex.EncodeToString(sum[:]),
		AccountID:      accountID,
		AgentID:        agentID,
		DeviceID:       deviceID,
		ExpiresAtMs:    nowMs + 3_600_000,
		CreatedAtMs:    nowMs,
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
}

func signedGeneric(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestWebhookPlatformVerifiersAcceptRealSchemesAndRejectTamper(t *testing.T) {
	tmp := t.TempDir()
	st, err := store.NewSQLiteStore(filepath.Join(tmp, "hub.sqlite"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()
	const nowMs = int64(1_795_400_000_000)
	seedSession(t, st, "acct-v", vecAgentID, "dev-v", "token-v", nowMs)
	secret := []byte("platform-secret-synthetic")
	svc, err := lease.NewWebhookIngressService(st, lease.WebhookIngressConfig{
		Secrets: map[string][]byte{
			"feishu": secret, "dingtalk": secret, "wecom": secret,
			"telegram": secret, "webhook": secret,
		},
		MaxBodyBytes:     64 * 1024,
		MaxQueuePerAgent: 32,
	}, func() time.Time { return time.UnixMilli(nowMs) })
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	if err := st.UpsertKeySlot(context.Background(), store.KeySlotEnvelope{
		AgentID: vecAgentID, Slot: lease.ChannelIngressSlotType,
		AADUTF8: `{"purpose":"channel-ingress"}`, CiphertextHex: hex.EncodeToString(bytes.Repeat([]byte{0x77}, 1216)),
		MetadataJSON: `{"key_id":"kid-test"}`, UpdatedAtMs: nowMs,
	}); err != nil {
		t.Fatalf("key slot: %v", err)
	}
	mux := http.NewServeMux()
	svc.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ts := fmt.Sprintf("%d", nowMs/1000)
	nonce := "nonce-1"
	feishuBody := []byte(`{"header":{"event_id":"ev_feishu_platform"},"event":{"message":{"message_id":"om-1"}}}`)
	feishuSig := sha256.Sum256(append(append(append([]byte(ts), []byte(nonce)...), secret...), feishuBody...))

	dingBody := []byte(`{"msgId":"ev_ding_platform","text":{"content":"hello"}}`)
	dingMac := hmac.New(sha256.New, secret)
	dingMac.Write([]byte(ts + "\n" + string(secret)))
	dingSign := base64.StdEncoding.EncodeToString(dingMac.Sum(nil))

	wecomBody := []byte(`<xml><MsgId>ev_wecom_platform</MsgId><Encrypt>ciphertextblob</Encrypt></xml>`)
	wecomItems := []string{string(secret), ts, nonce, "ciphertextblob"}
	sort.Strings(wecomItems)
	wecomSum := sha1.Sum([]byte(wecomItems[0] + wecomItems[1] + wecomItems[2] + wecomItems[3]))
	wecomSig := hex.EncodeToString(wecomSum[:])

	telegramBody := []byte(`{"update_id":4242,"message":{"message_id":1,"from":{"id":9},"chat":{"id":9},"text":"tg"}}`)
	webhookBody := []byte(`{"event_id":"ev_generic_platform","text":"generic"}`)

	type platformCase struct {
		name   string
		body   []byte
		mutate func(*http.Request)
		url    string
	}
	mk := func(channel string, body []byte, headers map[string]string, query string) platformCase {
		return platformCase{
			name: channel,
			body: body,
			url:  srv.URL + "/v1/webhook/" + vecAgentID + "/" + channel + query,
			mutate: func(req *http.Request) {
				for k, v := range headers {
					req.Header.Set(k, v)
				}
			},
		}
	}
	cases := []platformCase{
		mk("feishu", feishuBody, map[string]string{
			"X-Lark-Request-Timestamp": ts, "X-Lark-Request-Nonce": nonce,
			"X-Lark-Signature": hex.EncodeToString(feishuSig[:]),
		}, ""),
		mk("dingtalk", dingBody, map[string]string{"timestamp": ts, "sign": dingSign}, ""),
		mk("wecom", wecomBody, nil, "?timestamp="+ts+"&nonce="+nonce+"&msg_signature="+wecomSig),
		mk("telegram", telegramBody, map[string]string{"X-Telegram-Bot-Api-Secret-Token": string(secret)}, ""),
		mk("webhook", webhookBody, map[string]string{"X-QZ-Signature": signedGeneric(secret, webhookBody)}, ""),
	}
	for _, tc := range cases {
		req, _ := http.NewRequest(http.MethodPost, tc.url, bytes.NewReader(tc.body))
		if tc.mutate != nil {
			tc.mutate(req)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("%s accept request: %v", tc.name, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("%s real platform signature expected 202, got %d", tc.name, resp.StatusCode)
		}

		// 篡改一个签名字段必须 401。
		req2, _ := http.NewRequest(http.MethodPost, tc.url, bytes.NewReader(tc.body))
		if tc.mutate != nil {
			tc.mutate(req2)
		}
		switch tc.name {
		case "feishu":
			req2.Header.Set("X-Lark-Signature", "00"+hex.EncodeToString(feishuSig[:])[2:])
		case "dingtalk":
			req2.Header.Set("sign", "AAAA"+dingSign[4:])
		case "wecom":
			req2.URL.RawQuery = "timestamp=" + ts + "&nonce=" + nonce + "&msg_signature=0000000000000000000000000000000000000000"
		case "telegram":
			req2.Header.Set("X-Telegram-Bot-Api-Secret-Token", "wrong")
		case "webhook":
			req2.Header.Set("X-QZ-Signature", "sha256="+hex.EncodeToString(bytes.Repeat([]byte{0x00}, 32)))
		}
		resp2, err := srv.Client().Do(req2)
		if err != nil {
			t.Fatalf("%s tamper request: %v", tc.name, err)
		}
		_ = resp2.Body.Close()
		if resp2.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s tampered signature expected 401, got %d", tc.name, resp2.StatusCode)
		}
	}
}

type fakeAuthz struct{}

func (fakeAuthz) RequireAgentOwner(w http.ResponseWriter, r *http.Request, agentID string) (*auth.Principal, *store.Agent, bool) {
	token := r.Header.Get("Authorization")
	switch {
	case token == "Bearer owner-a" && agentID == vecAgentID:
		return &auth.Principal{AccountID: "acct-v", AgentID: agentID}, &store.Agent{AgentID: agentID, OwnerAccountID: "acct-v"}, true
	case token == "Bearer owner-b":
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"PERMISSION_DENIED","detail":"account does not own target agent"}`))
		return nil, nil, false
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"CREDENTIAL_REJECTED","detail":"invalid token"}`))
		return nil, nil, false
	}
}

func TestWebhookIngressOwnerRoutesLifecycleAndCrossAccount403(t *testing.T) {
	tmp := t.TempDir()
	st, err := store.NewSQLiteStore(filepath.Join(tmp, "hub.sqlite"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer st.Close()
	const nowMs = int64(1_795_400_000_000)
	seedSession(t, st, "acct-v", vecAgentID, "dev-v", "token-v", nowMs)
	seedSession(t, st, "acct-other", "11111111-0000-4000-8000-000000000000", "dev-other", "token-b", nowMs)
	secret := []byte("lifecycle-secret")
	svc, err := lease.NewWebhookIngressService(st, lease.WebhookIngressConfig{
		Secrets:          map[string][]byte{"webhook": secret},
		MaxBodyBytes:     64 * 1024,
		MaxQueuePerAgent: 1,
	}, func() time.Time { return time.UnixMilli(nowMs) })
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	mux := http.NewServeMux()
	svc.RegisterRoutes(mux)
	svc.RegisterOwnerRoutes(mux, fakeAuthz{})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	do := func(method, path, token string, body []byte) (int, []byte) {
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if method == http.MethodPost && len(body) > 0 {
			req.Header.Set("X-QZ-Signature", signedGeneric(secret, body))
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out bytes.Buffer
		_, _ = out.ReadFrom(resp.Body)
		return resp.StatusCode, out.Bytes()
	}

	body1 := []byte(`{"event_id":"ev_life_1","text":"first"}`)
	// 注册前：必须 409（缺 ChannelIngressKey）。
	if code, _ := do(http.MethodPost, "/v1/webhook/"+vecAgentID+"/webhook", "", body1); code != http.StatusConflict {
		t.Fatalf("before key registration expected 409, got %d", code)
	}

	keyBody, _ := json.Marshal(map[string]string{
		"xwing_pubkey_hex": hex.EncodeToString(bytes.Repeat([]byte{0x55}, 1216)),
		"key_id":           "kid-life",
	})
	// 真实 auth.Service 登记路由（复用 requireAgentOwner）。
	authSvc, err := auth.NewService(st, nil, auth.Config{}, func() time.Time { return time.UnixMilli(nowMs) })
	if err != nil {
		t.Fatalf("auth service: %v", err)
	}
	authMux := http.NewServeMux()
	authSvc.RegisterChannelIngressRoutes(authMux)
	authSrv := httptest.NewServer(authMux)
	defer authSrv.Close()
	req, _ := http.NewRequest(http.MethodPut, authSrv.URL+"/v1/auth/slots/"+vecAgentID+"/channel_ingress", bytes.NewReader(keyBody))
	req.Header.Set("Authorization", "Bearer token-v")
	req.Header.Set("Content-Type", "application/json")
	resp, err := authSrv.Client().Do(req)
	if err != nil {
		t.Fatalf("register key: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register key expected 200, got %d", resp.StatusCode)
	}

	if code, raw := do(http.MethodPost, "/v1/webhook/"+vecAgentID+"/webhook", "", body1); code != http.StatusAccepted {
		t.Fatalf("after key registration expected 202, got %d (%s)", code, raw)
	}
	body2 := []byte(`{"event_id":"ev_life_2","text":"second"}`)
	if code, _ := do(http.MethodPost, "/v1/webhook/"+vecAgentID+"/webhook", "", body2); code != http.StatusTooManyRequests {
		t.Fatalf("queue bound expected 429, got %d", code)
	}

	code, raw := do(http.MethodGet, "/v1/webhook/"+vecAgentID+"/ingress?after=0&limit=10", "owner-a", nil)
	if code != http.StatusOK {
		t.Fatalf("GET ingress expected 200, got %d (%s)", code, raw)
	}
	var listed struct {
		Events []struct {
			EventID string `json:"event_id"`
			Cursor  int64  `json:"cursor"`
		} `json:"events"`
		QueueDepth int `json:"queue_depth"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatalf("decode ingress: %v", err)
	}
	if len(listed.Events) != 1 || listed.QueueDepth != 1 {
		t.Fatalf("expected one sealed event/depth 1, got %+v", listed)
	}
	ackBody, _ := json.Marshal(map[string][]string{"event_ids": {listed.Events[0].EventID}})
	if code, raw := do(http.MethodPost, "/v1/webhook/"+vecAgentID+"/ingress/ack", "owner-a", ackBody); code != http.StatusOK {
		t.Fatalf("ack expected 200, got %d (%s)", code, raw)
	}
	code, raw = do(http.MethodGet, "/v1/webhook/"+vecAgentID+"/status", "owner-a", nil)
	if code != http.StatusOK || !bytes.Contains(raw, []byte(`"queue_depth":0`)) || !bytes.Contains(raw, []byte(`"key_id":"kid-life"`)) {
		t.Fatalf("status after ack: %d %s", code, raw)
	}
	body3 := []byte(`{"event_id":"ev_life_3","text":"third"}`)
	if code, raw := do(http.MethodPost, "/v1/webhook/"+vecAgentID+"/webhook", "", body3); code != http.StatusAccepted {
		t.Fatalf("third POST after ack expected 202, got %d (%s)", code, raw)
	}

	// 跨账号：注册、读取、确认、状态四条路由全部 403。
	for _, tc := range []struct {
		method, path string
		body         []byte
	}{
		{http.MethodPut, "/v1/auth/slots/" + vecAgentID + "/channel_ingress", keyBody},
		{http.MethodGet, "/v1/webhook/" + vecAgentID + "/ingress?after=0&limit=10", nil},
		{http.MethodPost, "/v1/webhook/" + vecAgentID + "/ingress/ack", []byte(`{"event_ids":[]}`)},
		{http.MethodGet, "/v1/webhook/" + vecAgentID + "/status", nil},
	} {
		var target string
		if tc.method == http.MethodPut && strings.Contains(tc.path, "/v1/auth/slots") {
			target = authSrv.URL + tc.path
			req, _ := http.NewRequest(tc.method, target, bytes.NewReader(tc.body))
			req.Header.Set("Authorization", "Bearer token-b")
			r, err := authSrv.Client().Do(req)
			if err != nil {
				t.Fatalf("cross PUT: %v", err)
			}
			_ = r.Body.Close()
			if r.StatusCode != http.StatusForbidden {
				t.Fatalf("cross-account key registration expected 403, got %d", r.StatusCode)
			}
			continue
		}
		code, _ := do(tc.method, tc.path, "owner-b", tc.body)
		if code != http.StatusForbidden {
			t.Fatalf("cross-account %s %s expected 403, got %d", tc.method, tc.path, code)
		}
	}
}

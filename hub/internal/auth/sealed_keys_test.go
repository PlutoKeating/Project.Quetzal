// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

const (
	keysAgent   = "018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f"
	keysDeviceA = "11111111-2222-4333-8444-555555555555"
	keysDeviceB = "66666666-7777-4888-8999-000000000000"
)

func seedAgentWithDevices(t *testing.T, st *store.SQLiteStore, nowMs int64) {
	t.Helper()
	ctx := context.Background()
	if err := st.CreateAccount(ctx, store.Account{AccountID: "acct", CreatedAtMs: nowMs}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateAgent(ctx, store.Agent{AgentID: keysAgent, OwnerAccountID: "acct",
		RootVerifyingKeyHex: hex.EncodeToString(bytes.Repeat([]byte{0x11}, 32)), QuotaBytes: 1 << 20, CreatedAtMs: nowMs}); err != nil {
		t.Fatal(err)
	}
	for _, dev := range []string{keysDeviceA, keysDeviceB} {
		if err := st.UpsertDevice(ctx, store.Device{AgentID: keysAgent, DeviceID: dev, AccountID: "acct",
			Ed25519PubKeyHex: hex.EncodeToString(bytes.Repeat([]byte{0x22}, 32)),
			XWingPubKeyHex:   hex.EncodeToString(bytes.Repeat([]byte{0x33}, 1216)), CreatedAtMs: nowMs}); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte("token-" + dev))
		if err := st.CreateSession(ctx, store.Session{TokenSHA256Hex: hex.EncodeToString(sum[:]), AccountID: "acct",
			AgentID: keysAgent, DeviceID: dev, ExpiresAtMs: nowMs + 3_600_000, CreatedAtMs: nowMs}); err != nil {
			t.Fatal(err)
		}
	}
}

// 设备之间传递的封存钥匙：寄给谁只有谁取得到；抹除时一次删掉所有设备上的那一份。
func TestSealedKeysReachOnlyTheirRecipientAndEraseEverywhere(t *testing.T) {
	st, err := store.NewSQLiteStore(filepath.Join(t.TempDir(), "hub.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const nowMs = int64(1_795_400_000_000)
	seedAgentWithDevices(t, st, nowMs)
	svc, err := auth.NewService(st, nil, auth.Config{}, func() time.Time { return time.UnixMilli(nowMs) })
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	svc.RegisterSealedKeyRoutes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	do := func(method, path, device string, body any) (int, map[string]any) {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer token-"+device)
		req.Header.Set("Content-Type", "application/json")
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	sealed := map[string]string{"aad_utf8": "x", "ciphertext_hex": "abcd", "hpke_enc_hex": "ef01"}
	name := "sea.entry-key/memory/mem-1"
	for _, dev := range []string{keysDeviceA, keysDeviceB} {
		if code, out := do(http.MethodPut, "/v1/keys/"+keysAgent+"/"+dev+"/"+name, keysDeviceA, sealed); code != 200 {
			t.Fatalf("put for %s: %d %v", dev, code, out)
		}
	}
	if code, out := do(http.MethodPut, "/v1/keys/"+keysAgent+"/"+keysDeviceB+"/sea.entry-key/memory/mem-2", keysDeviceA, sealed); code != 200 {
		t.Fatalf("put second: %d %v", code, out)
	}
	if code, _ := do(http.MethodGet, "/v1/keys/"+keysAgent+"/"+keysDeviceB, keysDeviceA, nil); code != http.StatusForbidden {
		t.Fatalf("another device must not read B's keys, got %d", code)
	}
	code, out := do(http.MethodGet, "/v1/keys/"+keysAgent+"/"+keysDeviceB, keysDeviceB, nil)
	if code != 200 || len(out["items"].([]any)) != 2 {
		t.Fatalf("B lists its two keys: %d %v", code, out)
	}
	if code, out := do(http.MethodDelete, "/v1/keys/"+keysAgent+"/"+name, keysDeviceB, nil); code != 200 || out["deleted"].(float64) != 2 {
		t.Fatalf("erase deletes both copies: %d %v", code, out)
	}
	code, out = do(http.MethodGet, "/v1/keys/"+keysAgent+"/"+keysDeviceB, keysDeviceB, nil)
	if code != 200 || len(out["items"].([]any)) != 1 {
		t.Fatalf("only the other key remains: %d %v", code, out)
	}
	if code, _ := do(http.MethodPut, "/v1/keys/"+keysAgent+"/"+keysDeviceB+"/../etc", keysDeviceA, sealed); code == 200 {
		t.Fatal("path tricks must be rejected")
	}
}

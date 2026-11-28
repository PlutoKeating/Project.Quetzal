// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

// 应急恢复包：只认所有者会话；新的盖掉旧的；删了就没有。
func TestRecoveryKitIsOwnerOnlyAndReplaceable(t *testing.T) {
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
	svc.RegisterRecoveryRoutes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	do := func(method, token string, body any) (int, map[string]any) {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, srv.URL+"/v1/recovery/"+keysAgent, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	kit := map[string]any{"salt_hex": "00ff", "memory_kib": 65536, "iterations": 3, "parallelism": 1, "nonce_hex": "abcd", "ciphertext_hex": "deadbeef"}
	if code, _ := do(http.MethodGet, "token-"+keysDeviceA, nil); code != http.StatusNotFound {
		t.Fatalf("nothing stored yet, got %d", code)
	}
	if code, out := do(http.MethodPut, "token-"+keysDeviceA, kit); code != 200 {
		t.Fatalf("put: %d %v", code, out)
	}
	kit["ciphertext_hex"] = "cafe"
	if code, out := do(http.MethodPut, "token-"+keysDeviceB, kit); code != 200 {
		t.Fatalf("replace: %d %v", code, out)
	}
	code, out := do(http.MethodGet, "token-"+keysDeviceA, nil)
	if code != 200 || out["ciphertext_hex"] != "cafe" || out["memory_kib"].(float64) != 65536 {
		t.Fatalf("latest kit with its parameters: %d %v", code, out)
	}
	if code, _ := do(http.MethodGet, "token-nobody", nil); code == 200 {
		t.Fatal("a stranger must not read the kit")
	}
	if code, _ := do(http.MethodPut, "token-"+keysDeviceA, map[string]any{"salt_hex": "zz"}); code == 200 {
		t.Fatal("malformed kit must be rejected")
	}
	if code, out := do(http.MethodDelete, "token-"+keysDeviceA, nil); code != 200 || out["deleted"].(float64) != 1 {
		t.Fatalf("delete: %d %v", code, out)
	}
	if code, _ := do(http.MethodGet, "token-"+keysDeviceA, nil); code != http.StatusNotFound {
		t.Fatal("deleted kit is gone")
	}
}

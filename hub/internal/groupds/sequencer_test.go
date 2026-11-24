// SPDX-License-Identifier: AGPL-3.0-only

package groupds_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/groupds"
	"quetzalcoatl-hub/internal/store"
)

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }

func testHex(byteLen int, fill byte) string {
	raw := bytes.Repeat([]byte{fill}, byteLen)
	return hex.EncodeToString(raw)
}

func seedAgent(t *testing.T, st *store.SQLiteStore, accountID, agentID, deviceID, token string, nowMs int64) {
	t.Helper()
	ctx := context.Background()
	if err := st.CreateAccount(ctx, store.Account{AccountID: accountID, CreatedAtMs: nowMs}); err != nil {
		t.Fatalf("CreateAccount(%s): %v", accountID, err)
	}
	if err := st.CreateAgent(ctx, store.Agent{
		AgentID:             agentID,
		OwnerAccountID:      accountID,
		RootVerifyingKeyHex: testHex(32, 0x11),
		QuotaBytes:          1 << 20,
		CreatedAtMs:         nowMs,
	}); err != nil {
		t.Fatalf("CreateAgent(%s): %v", agentID, err)
	}
	if err := st.UpsertDevice(ctx, store.Device{
		AgentID:          agentID,
		DeviceID:         deviceID,
		AccountID:        accountID,
		Ed25519PubKeyHex: testHex(32, 0x22),
		XWingPubKeyHex:   testHex(1216, 0x33),
		CreatedAtMs:      nowMs,
	}); err != nil {
		t.Fatalf("UpsertDevice(%s): %v", deviceID, err)
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
		t.Fatalf("CreateSession(%s): %v", agentID, err)
	}
}

func doJSON(t *testing.T, client *http.Client, method, url, bearer string, body any) (*http.Response, []byte) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rdr = bytes.NewReader(raw)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := client.Do(req)
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

type harness struct {
	srv    *httptest.Server
	st     *store.SQLiteStore
	dbPath string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "hub.sqlite")
	st, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	clk := fixedClock{now: time.UnixMilli(1_795_400_000_000)}
	var secret [32]byte
	copy(secret[:], bytes.Repeat([]byte{0x42}, 32))
	blobs, err := store.NewLocalBlobStore(filepath.Join(tmpDir, "blobs"), "http://127.0.0.1", secret, st, clk.Now)
	if err != nil {
		t.Fatalf("NewLocalBlobStore: %v", err)
	}
	authSvc, err := auth.NewService(st, blobs, auth.Config{
		RPID:                   "hub.quetzalcoatl.example",
		AllowedOrigins:         []string{"https://hub.quetzalcoatl.example"},
		ServerIdentity:         "server:quetzalcoatl-hub:v2",
		PairingHMACSecret:      secret,
		DefaultAgentQuotaBytes: 1 << 20,
	}, clk.Now)
	if err != nil {
		t.Fatalf("auth.NewService: %v", err)
	}
	svc, err := groupds.NewService(st, authSvc, clk.Now)
	if err != nil {
		t.Fatalf("groupds.NewService: %v", err)
	}
	mux := http.NewServeMux()
	svc.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	nowMs := clk.Now().UnixMilli()
	seedAgent(t, st, "acc-a", "agent-a", "dev-a", "token-a", nowMs)
	seedAgent(t, st, "acc-b", "agent-b", "dev-b", "token-b", nowMs)
	seedAgent(t, st, "acc-c", "agent-c", "dev-c", "token-c", nowMs)

	return &harness{srv: srv, st: st, dbPath: dbPath}
}

func (h *harness) createRoom(t *testing.T, bearer, groupID, ownerAgent string, secrecyLevel int) {
	t.Helper()
	resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups", bearer, map[string]any{
		"group_id":       groupID,
		"owner_agent_id": ownerAgent,
		"secrecy_level":  secrecyLevel,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create room: %d %s", resp.StatusCode, body)
	}
}

func (h *harness) addMember(t *testing.T, bearer, groupID, agentID, role string) {
	t.Helper()
	resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/"+groupID+"/members", bearer, map[string]any{
		"agent_id": agentID,
		"role":     role,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("add member: %d %s", resp.StatusCode, body)
	}
}

func TestCommitSequencerAllocatesMonotonicPerGroupSequenceAtomically(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "family", "agent-a", 1)
	h.addMember(t, "token-a", "family", "agent-b", "member")

	const writers = 12
	var wg sync.WaitGroup
	seqs := make(chan uint64, writers)
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ciphertext := base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("opaque-ciphertext-%02d", idx)))
			resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/family/commits", "token-b", map[string]any{
				"mls_epoch":         1,
				"causal_parent_seq": 0,
				"sender_agent_id":   "agent-b",
				"sender_device_id":  "dev-b",
				"mentions":          []map[string]any{{"kind": "addressee", "target_agent_id": "agent-a"}},
				"ciphertext_b64":    ciphertext,
			})
			if resp.StatusCode != http.StatusCreated {
				errs <- fmt.Errorf("commit %d: status %d body %s", idx, resp.StatusCode, body)
				return
			}
			var parsed struct {
				ServerSeq uint64 `json:"server_seq"`
			}
			if err := json.Unmarshal(body, &parsed); err != nil {
				errs <- fmt.Errorf("commit %d: parse: %w", idx, err)
				return
			}
			seqs <- parsed.ServerSeq
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent commit failed: %v", err)
	}
	close(seqs)
	seen := make(map[uint64]bool, writers)
	for seq := range seqs {
		if seen[seq] {
			t.Fatalf("duplicate server_seq %d", seq)
		}
		seen[seq] = true
	}
	for want := uint64(1); want <= writers; want++ {
		if !seen[want] {
			t.Fatalf("missing server_seq %d (got %v)", want, seen)
		}
	}

	resp, body := doJSON(t, h.srv.Client(), http.MethodGet, h.srv.URL+"/v1/groups/family/commits?after_seq=9", "token-a", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list commits: %d %s", resp.StatusCode, body)
	}
	var listed struct {
		Commits []struct {
			ServerSeq   uint64 `json:"server_seq"`
			MLSEpoch    uint64 `json:"mls_epoch"`
			SenderAgent string `json:"sender_agent_id"`
			Mentions    []any  `json:"mentions"`
		} `json:"commits"`
	}
	if err := json.Unmarshal(body, &listed); err != nil {
		t.Fatalf("parse list: %v", err)
	}
	if len(listed.Commits) != writers-9 {
		t.Fatalf("expected %d commits after seq 9, got %d", writers-9, len(listed.Commits))
	}
	for idx, c := range listed.Commits {
		if c.ServerSeq != uint64(10+idx) {
			t.Fatalf("commits not strictly ordered after watermark: %+v", listed.Commits)
		}
		if c.MLSEpoch != 1 {
			t.Fatalf("mls_epoch not preserved: %+v", c)
		}
	}
}

func TestCommitSequencerEnforcesGroupExistenceAndMembership(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "secret-family", "agent-a", 2)
	h.addMember(t, "token-a", "secret-family", "agent-b", "member")

	// Unknown group MUST be 404.
	resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/nope/commits", "token-a", map[string]any{
		"mls_epoch":         1,
		"causal_parent_seq": 0,
		"sender_agent_id":   "agent-a",
		"sender_device_id":  "dev-a",
		"mentions":          []any{},
		"ciphertext_b64":    base64.StdEncoding.EncodeToString([]byte("ct")),
	})
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown group expected 404, got %d (%s)", resp.StatusCode, body)
	}

	// Non-member (agent-c) MUST be 403 even though authentication succeeds.
	resp, body = doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/secret-family/commits", "token-c", map[string]any{
		"mls_epoch":         1,
		"causal_parent_seq": 0,
		"sender_agent_id":   "agent-c",
		"sender_device_id":  "dev-c",
		"mentions":          []any{},
		"ciphertext_b64":    base64.StdEncoding.EncodeToString([]byte("ct")),
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-member expected 403, got %d (%s)", resp.StatusCode, body)
	}

	// Sender spoofing must be rejected: authenticated agent-b cannot claim agent-a.
	resp, body = doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/secret-family/commits", "token-b", map[string]any{
		"mls_epoch":         1,
		"causal_parent_seq": 0,
		"sender_agent_id":   "agent-a",
		"sender_device_id":  "dev-a",
		"mentions":          []any{},
		"ciphertext_b64":    base64.StdEncoding.EncodeToString([]byte("ct")),
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("sender spoof expected 403, got %d (%s)", resp.StatusCode, body)
	}

	// Unauthenticated MUST be 401.
	resp, body = doJSON(t, h.srv.Client(), http.MethodGet, h.srv.URL+"/v1/groups/secret-family/commits?after_seq=0", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated expected 401, got %d (%s)", resp.StatusCode, body)
	}
}

func TestCommitSequencerRejectsMalformedCiphertext(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "strict-room", "agent-a", 1)

	for _, tc := range []struct {
		name   string
		status int
		body   map[string]any
	}{
		{"empty_ciphertext", http.StatusBadRequest, map[string]any{"ciphertext_b64": ""}},
		{"invalid_base64", http.StatusBadRequest, map[string]any{"ciphertext_b64": "!!!not-base64!!!"}},
		{"sender_device_mismatch", http.StatusForbidden, map[string]any{"ciphertext_b64": base64.StdEncoding.EncodeToString([]byte("ct")), "sender_device_id": "dev-other"}},
	} {
		body := map[string]any{
			"mls_epoch":         1,
			"causal_parent_seq": 0,
			"sender_agent_id":   "agent-a",
			"sender_device_id":  "dev-a",
			"mentions":          []any{},
		}
		for k, v := range tc.body {
			body[k] = v
		}
		resp, raw := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/strict-room/commits", "token-a", body)
		if resp.StatusCode != tc.status {
			t.Fatalf("%s expected %d, got %d (%s)", tc.name, tc.status, resp.StatusCode, raw)
		}
	}
}

func TestGroupCommitStoreIsZeroKnowledgeAndSchemaHasNoPlaintextColumns(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "canary-room", "agent-a", 3)
	h.addMember(t, "token-a", "canary-room", "agent-b", "member")

	// 诱饵字段：客户端错误地把明文提示词/记忆塞进请求。服务端必须忽略且绝不落盘。
	canaryPrompt := "CANARY-PROMPT-群聊明文绝不可落盘-998877"
	canaryMemory := "CANARY-MEMORY-主人过敏史-绝不可落盘-112233"
	ciphertext := []byte("opaque-mls-ciphertext-bytes")
	resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/canary-room/commits", "token-b", map[string]any{
		"mls_epoch":         2,
		"causal_parent_seq": 0,
		"sender_agent_id":   "agent-b",
		"sender_device_id":  "dev-b",
		"mentions":          []map[string]any{{"kind": "cc", "target_agent_id": "agent-a"}},
		"ciphertext_b64":    base64.StdEncoding.EncodeToString(ciphertext),
		"plaintext_prompt":  canaryPrompt,
		"memory":            canaryMemory,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("commit: %d %s", resp.StatusCode, body)
	}

	db, err := sql.Open("sqlite", h.dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	rows, err := db.Query("PRAGMA table_info(group_commits)")
	if err != nil {
		t.Fatalf("table_info: %v", err)
	}
	defer rows.Close()
	allowed := map[string]bool{
		"group_id": true, "server_seq": true, "mls_epoch": true, "causal_parent_seq": true,
		"sender_agent_id": true, "sender_device_id": true, "mentions_json": true,
		"ciphertext_b64": true, "created_at_ms": true,
	}
	found := 0
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err != nil {
			t.Fatalf("scan table_info: %v", err)
		}
		found++
		if !allowed[name] {
			t.Fatalf("group_commits contains forbidden plaintext column %q", name)
		}
	}
	if found != len(allowed) {
		t.Fatalf("group_commits column count mismatch: got %d want %d", found, len(allowed))
	}
}

func TestGroupCommitDiskCanaryScanFindsNoPlaintext(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "canary-disk", "agent-a", 1)
	h.addMember(t, "token-a", "canary-disk", "agent-b", "member")

	canary := "CANARY-GROUP-PLAINTEXT-NEVER-ON-DISK-556677"
	resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/canary-disk/commits", "token-b", map[string]any{
		"mls_epoch":         1,
		"causal_parent_seq": 0,
		"sender_agent_id":   "agent-b",
		"sender_device_id":  "dev-b",
		"mentions":          []any{},
		"ciphertext_b64":    base64.StdEncoding.EncodeToString([]byte("ciphertext-only")),
		"plaintext_prompt":  canary,
		"memory_content":    canary,
		"prompt":            canary,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("commit: %d %s", resp.StatusCode, body)
	}
	// Flush WAL into the main database for a deterministic disk scan.
	cpDB, err := sql.Open("sqlite", h.dbPath)
	if err != nil {
		t.Fatalf("open sqlite for checkpoint: %v", err)
	}
	if _, err := cpDB.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		_ = cpDB.Close()
		t.Fatalf("wal checkpoint: %v", err)
	}
	_ = cpDB.Close()
	for _, path := range []string{h.dbPath, h.dbPath + "-wal"} {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if bytes.Contains(raw, []byte(canary)) {
			t.Fatalf("ZERO-KNOWLEDGE VIOLATION: plaintext prompt/memory canary found in %s", filepath.Base(path))
		}
	}
}

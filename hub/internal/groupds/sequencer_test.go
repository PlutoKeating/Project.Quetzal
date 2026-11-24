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
	"io"
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
			status, body, err := h.doJSONWorker(http.MethodPost, "/v1/groups/family/commits", "token-b", commitBody(map[string]any{
				"mls_epoch":         0,
				"causal_parent_seq": 0,
				"sender_agent_id":   "agent-b",
				"sender_device_id":  "dev-b",
				"mentions":          []map[string]any{{"kind": "addressee", "target_agent_id": "agent-a"}},
				"ciphertext_b64":    ciphertext,
			}))
			if err != nil {
				errs <- fmt.Errorf("commit %d: %w", idx, err)
				return
			}
			if status != http.StatusCreated {
				errs <- fmt.Errorf("commit %d: status %d body %s", idx, status, body)
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
		if c.MLSEpoch != 0 {
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
		"mls_epoch":         0,
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
		"ciphertext_b64": true, "kind": true, "author_kind": true, "hop": true,
		"created_at_ms": true,
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
		"mls_epoch":         0,
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

func (h *harness) postCommit(t *testing.T, bearer, groupID string, body map[string]any) (*http.Response, []byte) {
	t.Helper()
	return doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups/"+groupID+"/commits", bearer, commitBody(body))
}

// commitBody 生成带默认字段的提交请求体（供 `postCommit` 与工作 goroutine 共用）。
func commitBody(overrides map[string]any) map[string]any {
	base := map[string]any{
		"mls_epoch":         0,
		"causal_parent_seq": 0,
		"sender_agent_id":   "",
		"sender_device_id":  "",
		"mentions":          []any{},
		"kind":              "message",
		"author_kind":       "human",
		"reencrypt_only":    false,
		"ciphertext_b64":    base64.StdEncoding.EncodeToString([]byte("opaque-ct")),
	}
	for k, v := range overrides {
		base[k] = v
	}
	return base
}

// doJSONWorker 供工作 goroutine 使用：绝不调用 t.Fatalf，所有错误回传主 goroutine。
func (h *harness) doJSONWorker(method, path, bearer string, body any) (int, []byte, error) {
	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("marshal: %w", err)
		}
		payload = encoded
	}
	req, err := http.NewRequest(method, h.srv.URL+path, bytes.NewReader(payload))
	if err != nil {
		return 0, nil, fmt.Errorf("new request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := h.srv.Client().Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("do request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, fmt.Errorf("read body: %w", err)
	}
	return resp.StatusCode, raw, nil
}

// postCommitQuiet 在 worker goroutine 中提交；201/409 都是合法业务结果。
func (h *harness) postCommitQuiet(bearer, groupID string, body map[string]any) error {
	status, raw, err := h.doJSONWorker(http.MethodPost, "/v1/groups/"+groupID+"/commits", bearer, commitBody(body))
	if err != nil {
		return err
	}
	if status != http.StatusCreated && status != http.StatusConflict {
		return fmt.Errorf("unexpected status %d: %s", status, raw)
	}
	return nil
}

func TestCreateGroupIsIdempotentForOwner(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "idem-room", "agent-a", 1)
	resp, body := doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups", "token-a", map[string]any{
		"group_id":       "idem-room",
		"owner_agent_id": "agent-a",
		"secrecy_level":  1,
	})
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		t.Fatalf("idempotent create expected 2xx, got %d (%s)", resp.StatusCode, body)
	}
	// A different owner must be rejected.
	resp, body = doJSON(t, h.srv.Client(), http.MethodPost, h.srv.URL+"/v1/groups", "token-b", map[string]any{
		"group_id":       "idem-room",
		"owner_agent_id": "agent-b",
		"secrecy_level":  1,
	})
	if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusConflict {
		t.Fatalf("foreign owner recreate expected 4xx, got %d (%s)", resp.StatusCode, body)
	}
}

func TestCommitSequencerDerivesHopAndSilencesFourthAgentHop(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "hop-room", "agent-a", 1)
	h.addMember(t, "token-a", "hop-room", "agent-b", "member")

	parent := uint64(0)
	for hop := 1; hop <= 3; hop++ {
		resp, body := h.postCommit(t, "token-b", "hop-room", map[string]any{
			"sender_agent_id":   "agent-b",
			"sender_device_id":  "dev-b",
			"author_kind":       "agent",
			"kind":              "message",
			"causal_parent_seq": parent,
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("hop %d expected 201, got %d (%s)", hop, resp.StatusCode, body)
		}
		var out struct {
			ServerSeq uint64 `json:"server_seq"`
			Hop       int    `json:"hop"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("parse hop response: %v", err)
		}
		if out.Hop != hop {
			t.Fatalf("server-derived hop mismatch: got %d want %d", out.Hop, hop)
		}
		parent = out.ServerSeq
	}
	resp, body := h.postCommit(t, "token-b", "hop-room", map[string]any{
		"sender_agent_id":   "agent-b",
		"sender_device_id":  "dev-b",
		"author_kind":       "agent",
		"kind":              "message",
		"causal_parent_seq": parent,
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("fourth agent hop expected conflict, got %d (%s)", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte("FLOOR_SILENCED")) {
		t.Fatalf("expected FLOOR_SILENCED error code, got %s", body)
	}
	// Human speech resets the agent hop counter.
	resp, body = h.postCommit(t, "token-a", "hop-room", map[string]any{
		"sender_agent_id":   "agent-a",
		"sender_device_id":  "dev-a",
		"author_kind":       "human",
		"kind":              "message",
		"causal_parent_seq": parent,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("human reset expected 201, got %d (%s)", resp.StatusCode, body)
	}
}

func TestCommitSequencerValidatesEpochRotation(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "epoch-room", "agent-a", 1)

	// Local epoch ahead of the Hub without reencrypt flag = genuine divergence.
	resp, body := h.postCommit(t, "token-a", "epoch-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        1,
	})
	if resp.StatusCode != http.StatusConflict || !bytes.Contains(body, []byte("WATERMARK_CONFLICT")) {
		t.Fatalf("unflagged epoch bump expected WATERMARK_CONFLICT, got %d (%s)", resp.StatusCode, body)
	}
	// 409 必须携带真实群头，供客户端还原类型化 WatermarkConflict。
	var conflictBody struct {
		HeadGroupSeq uint64 `json:"head_group_seq"`
	}
	if err := json.Unmarshal(body, &conflictBody); err != nil {
		t.Fatalf("parse conflict body: %v", err)
	}
	if conflictBody.HeadGroupSeq != 0 {
		t.Fatalf("conflict must report real head 0, got %d", conflictBody.HeadGroupSeq)
	}

	// Pure key rotation: re-encrypted payload under EpochKey[e+1] is accepted and bumps the room epoch.
	resp, body = h.postCommit(t, "token-a", "epoch-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        1,
		"reencrypt_only":   true,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("reencrypt epoch rotation expected 201, got %d (%s)", resp.StatusCode, body)
	}

	// A stale epoch after rotation must be rejected.
	resp, body = h.postCommit(t, "token-a", "epoch-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        0,
	})
	if resp.StatusCode != http.StatusConflict || !bytes.Contains(body, []byte("WATERMARK_CONFLICT")) {
		t.Fatalf("stale epoch expected WATERMARK_CONFLICT, got %d (%s)", resp.StatusCode, body)
	}

	// The Hub exposes the authoritative head + epoch.
	resp, body = doJSON(t, h.srv.Client(), http.MethodGet, h.srv.URL+"/v1/groups/epoch-room/commits?after_seq=0&limit=2", "token-a", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("head query failed: %d %s", resp.StatusCode, body)
	}
	var head struct {
		HeadGroupSeq    uint64 `json:"head_group_seq"`
		CurrentMLSEpoch uint64 `json:"current_mls_epoch"`
	}
	if err := json.Unmarshal(body, &head); err != nil {
		t.Fatalf("parse head: %v", err)
	}
	if head.HeadGroupSeq != 1 || head.CurrentMLSEpoch != 1 {
		t.Fatalf("unexpected head/epoch: %+v", head)
	}
}

func TestCommitSequencerHeadIsTrueMaxNotPageMax(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "head-room", "agent-a", 1)
	for i := 0; i < 7; i++ {
		resp, body := h.postCommit(t, "token-a", "head-room", map[string]any{
			"sender_agent_id":  "agent-a",
			"sender_device_id": "dev-a",
		})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("seed commit %d failed: %d %s", i, resp.StatusCode, body)
		}
	}
	resp, body := doJSON(t, h.srv.Client(), http.MethodGet, h.srv.URL+"/v1/groups/head-room/commits?after_seq=0&limit=2", "token-a", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("head query failed: %d %s", resp.StatusCode, body)
	}
	var page struct {
		Commits      []any  `json:"commits"`
		HeadGroupSeq uint64 `json:"head_group_seq"`
	}
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("parse page: %v", err)
	}
	if len(page.Commits) != 2 {
		t.Fatalf("expected truncated page of 2, got %d", len(page.Commits))
	}
	if page.HeadGroupSeq != 7 {
		t.Fatalf("head must be true MAX(server_seq)=7, got %d", page.HeadGroupSeq)
	}
}

func TestDeleteGroupMemberRevokesCommitAccess(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "revoke-room", "agent-a", 1)
	h.addMember(t, "token-a", "revoke-room", "agent-b", "member")

	resp, body := doJSON(t, h.srv.Client(), http.MethodDelete, h.srv.URL+"/v1/groups/revoke-room/members/agent-a", "token-b", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin delete expected 403, got %d (%s)", resp.StatusCode, body)
	}
	resp, body = doJSON(t, h.srv.Client(), http.MethodDelete, h.srv.URL+"/v1/groups/revoke-room/members/agent-b", "token-a", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner delete expected 200, got %d (%s)", resp.StatusCode, body)
	}
	resp, body = h.postCommit(t, "token-b", "revoke-room", map[string]any{
		"sender_agent_id":  "agent-b",
		"sender_device_id": "dev-b",
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("kicked member commit expected 403, got %d (%s)", resp.StatusCode, body)
	}
	// 已被踢出者重试自我离群：幂等，成员行已不存在 → 404（客户端视为撤销成功）。
	resp, body = doJSON(t, h.srv.Client(), http.MethodDelete, h.srv.URL+"/v1/groups/revoke-room/members/agent-b", "token-b", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("idempotent self-leave expected 404, got %d (%s)", resp.StatusCode, body)
	}
	resp, body = doJSON(t, h.srv.Client(), http.MethodDelete, h.srv.URL+"/v1/groups/revoke-room/members/agent-c", "token-a", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown member delete expected 404, got %d (%s)", resp.StatusCode, body)
	}
}

func TestCommitSequencerRejectsEpochJumpBeyondOne(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "jump-room", "agent-a", 1)

	// 任意大步长纪元跳跃（此处 0 -> 2）绝不能被 reencrypt_only 洗白。
	resp, body := h.postCommit(t, "token-a", "jump-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        2,
		"reencrypt_only":   true,
	})
	if resp.StatusCode != http.StatusConflict || !bytes.Contains(body, []byte("WATERMARK_CONFLICT")) {
		t.Fatalf("two-epoch jump must be refused, got %d (%s)", resp.StatusCode, body)
	}

	// 恰 +1 的纯密钥轮换仍然允许。
	resp, body = h.postCommit(t, "token-a", "jump-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        1,
		"reencrypt_only":   true,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("single step rotation expected 201, got %d (%s)", resp.StatusCode, body)
	}
}

func TestEpochValidationIsAtomicWithCommitAppend(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "atomic-epoch", "agent-a", 1)

	const staleWriters = 12
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, staleWriters+1)
	fire := func(body map[string]any) {
		defer wg.Done()
		<-start
		// 工作 goroutine 绝不调用 t.Fatalf：只把错误回传主 goroutine 统一断言。
		if err := h.postCommitQuiet("token-a", "atomic-epoch", body); err != nil {
			errs <- err
		}
	}
	for i := 0; i < staleWriters; i++ {
		wg.Add(1)
		go fire(map[string]any{
			"sender_agent_id":  "agent-a",
			"sender_device_id": "dev-a",
			"mls_epoch":        0,
		})
	}
	wg.Add(1)
	go fire(map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        1,
		"reencrypt_only":   true,
	})
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent append failed: %v", err)
	}

	resp, body := doJSON(t, h.srv.Client(), http.MethodGet, h.srv.URL+"/v1/groups/atomic-epoch/commits?after_seq=0&limit=200", "token-a", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list commits: %d %s", resp.StatusCode, body)
	}
	var payload struct {
		Commits []struct {
			ServerSeq uint64 `json:"server_seq"`
			MLSEpoch  uint64 `json:"mls_epoch"`
		} `json:"commits"`
		HeadGroupSeq    uint64 `json:"head_group_seq"`
		CurrentMLSEpoch uint64 `json:"current_mls_epoch"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("parse commits: %v", err)
	}
	if payload.CurrentMLSEpoch != 1 {
		t.Fatalf("room epoch must settle at 1, got %d", payload.CurrentMLSEpoch)
	}
	var rotationSeq uint64
	for _, c := range payload.Commits {
		if c.MLSEpoch == 1 && (rotationSeq == 0 || c.ServerSeq < rotationSeq) {
			rotationSeq = c.ServerSeq
		}
	}
	if rotationSeq == 0 {
		t.Fatalf("rotation commit missing from %+v", payload.Commits)
	}
	for _, c := range payload.Commits {
		// 纪元校验必须与追加同事务：轮换生效后，任何更旧纪元的提交都不得落库。
		if c.MLSEpoch < 1 && c.ServerSeq > rotationSeq {
			t.Fatalf("stale epoch commit accepted after rotation: %+v (rotation seq %d)", c, rotationSeq)
		}
	}
}

func TestCommitSequencerAcceptsOpaqueMlsCommitWithoutHopInflation(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "mls-room", "agent-a", 1)

	// MLS 提交/提案是 Hub 不可解读的密文：必须作为独立 kind 接受，且不计入 Agent 对话跳数。
	resp, body := h.postCommit(t, "token-a", "mls-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        1,
		"reencrypt_only":   true,
		"kind":             "mls_commit",
		"author_kind":      "agent",
		"ciphertext_b64":   base64.StdEncoding.EncodeToString([]byte("opaque-mls-commit")),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mls_commit expected 201, got %d (%s)", resp.StatusCode, body)
	}
	var out struct {
		Kind string `json:"kind"`
		Hop  int    `json:"hop"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("parse mls_commit response: %v", err)
	}
	if out.Kind != "mls_commit" {
		t.Fatalf("kind must round-trip as mls_commit, got %q", out.Kind)
	}
	if out.Hop != 0 {
		t.Fatalf("mls_commit must never inflate agent hops, got %d", out.Hop)
	}

	// 后续 Agent 对话跳数仍从 1 起算，不被 MLS 提交污染。
	resp, body = h.postCommit(t, "token-a", "mls-room", map[string]any{
		"sender_agent_id":  "agent-a",
		"sender_device_id": "dev-a",
		"mls_epoch":        1,
		"kind":             "message",
		"author_kind":      "agent",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("agent message expected 201, got %d (%s)", resp.StatusCode, body)
	}
	var msg struct {
		Hop int `json:"hop"`
	}
	if err := json.Unmarshal(body, &msg); err != nil {
		t.Fatalf("parse message response: %v", err)
	}
	if msg.Hop != 1 {
		t.Fatalf("agent message hop must start at 1, got %d", msg.Hop)
	}
}

func TestEpochAdvanceIsExclusivePerEpoch(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "fork-room", "agent-a", 1)
	h.addMember(t, "token-a", "fork-room", "agent-b", "member")

	// 两个成员同时声称建立 E+1：只允许一个成功，另一个必须拿到类型化冲突。
	start := make(chan struct{})
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for _, bearer := range []struct{ token, agent, device string }{
		{"token-a", "agent-a", "dev-a"},
		{"token-b", "agent-b", "dev-b"},
	} {
		wg.Add(1)
		go func(token, agent, device string) {
			defer wg.Done()
			<-start
			status, _, err := h.doJSONWorker(http.MethodPost, "/v1/groups/fork-room/commits", token, commitBody(map[string]any{
				"sender_agent_id":  agent,
				"sender_device_id": device,
				"mls_epoch":        1,
				"reencrypt_only":   true,
				"kind":             "mls_commit",
				"author_kind":      "agent",
				"ciphertext_b64":   base64.StdEncoding.EncodeToString([]byte("opaque-mls-commit")),
			}))
			if err != nil {
				status = -1
			}
			statuses <- status
		}(bearer.token, bearer.agent, bearer.device)
	}
	close(start)
	wg.Wait()
	close(statuses)

	created, conflicted := 0, 0
	for status := range statuses {
		switch status {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflicted++
		default:
			t.Fatalf("unexpected status %d", status)
		}
	}
	if created != 1 || conflicted != 1 {
		t.Fatalf("epoch advance must be exclusive: created=%d conflicted=%d", created, conflicted)
	}

	// 房间纪元只能前进一次，且只有一条提交落到日志里。
	resp, body := doJSON(t, h.srv.Client(), http.MethodGet, h.srv.URL+"/v1/groups/fork-room/commits?after_seq=0&limit=50", "token-a", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list commits: %d %s", resp.StatusCode, body)
	}
	var payload struct {
		Commits         []any  `json:"commits"`
		CurrentMLSEpoch uint64 `json:"current_mls_epoch"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("parse commits: %v", err)
	}
	if payload.CurrentMLSEpoch != 1 || len(payload.Commits) != 1 {
		t.Fatalf("fork detected: epoch=%d commits=%d", payload.CurrentMLSEpoch, len(payload.Commits))
	}
}

func TestCommitSequencerRejectsUnknownKindAndAuthorKind(t *testing.T) {
	h := newHarness(t)
	h.createRoom(t, "token-a", "kind-room", "agent-a", 1)
	cases := []struct{ kind, authorKind string }{
		{"bogus-kind", "human"},
		{"message", "robot"},
	}
	for _, tc := range cases {
		resp, body := h.postCommit(t, "token-a", "kind-room", map[string]any{
			"sender_agent_id":  "agent-a",
			"sender_device_id": "dev-a",
			"kind":             tc.kind,
			"author_kind":      tc.authorKind,
		})
		if resp.StatusCode != http.StatusBadRequest || !bytes.Contains(body, []byte("SERIALIZATION_ERROR")) {
			t.Fatalf("unknown kind/author_kind must fail closed with 400, got %d (%s)", resp.StatusCode, body)
		}
	}
}

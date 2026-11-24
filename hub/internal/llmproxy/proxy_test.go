// SPDX-License-Identifier: AGPL-3.0-only

package llmproxy_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/llmproxy"
	"quetzalcoatl-hub/internal/store"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type llmTestEnv struct {
	st          store.Store
	authSvc     *auth.Service
	accountID   string
	agentID     string
	deviceID    string
	bearerToken string
}

func setupLLMTestEnv(t *testing.T) *llmTestEnv {
	t.Helper()
	tmpDir := t.TempDir()
	st, err := store.NewSQLiteStore(filepath.Join(tmpDir, "hub.sqlite"))
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	var secret [32]byte
	secret[0] = 7
	blobs, err := store.NewLocalBlobStore(filepath.Join(tmpDir, "blobs"), "http://localhost", secret, st, time.Now)
	if err != nil {
		t.Fatalf("NewLocalBlobStore: %v", err)
	}
	authSvc, err := auth.NewService(st, blobs, auth.Config{RPID: "localhost"}, time.Now)
	if err != nil {
		t.Fatalf("auth.NewService: %v", err)
	}

	ctx := context.Background()
	accID := "acc_test_01"
	agentID := strings.Repeat("a1", 16)
	devID := strings.Repeat("d1", 16)
	nowMs := time.Now().UnixMilli()

	if err := st.CreateAccount(ctx, store.Account{AccountID: accID, CreatedAtMs: nowMs}); err != nil {
		t.Fatalf("CreateAccount: %v", err)
	}
	if err := st.CreateAgent(ctx, store.Agent{
		AgentID:             agentID,
		OwnerAccountID:      accID,
		RootVerifyingKeyHex: strings.Repeat("11", 32),
		QuotaBytes:          1024 * 1024,
		CreatedAtMs:         nowMs,
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := st.UpsertDevice(ctx, store.Device{
		AgentID:          agentID,
		DeviceID:         devID,
		AccountID:        accID,
		Ed25519PubKeyHex: strings.Repeat("22", 32),
		XWingPubKeyHex:   strings.Repeat("33", 32),
		CreatedAtMs:      nowMs,
	}); err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}

	rawToken := "qz_sess_secret_token_for_llm_proxy_test"
	sum := sha256.Sum256([]byte(rawToken))
	if err := st.CreateSession(ctx, store.Session{
		TokenSHA256Hex: hex.EncodeToString(sum[:]),
		AccountID:      accID,
		AgentID:        agentID,
		DeviceID:       devID,
		ExpiresAtMs:    nowMs + 3600_000,
		CreatedAtMs:    nowMs,
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	return &llmTestEnv{
		st:          st,
		authSvc:     authSvc,
		accountID:   accID,
		agentID:     agentID,
		deviceID:    devID,
		bearerToken: rawToken,
	}
}

func TestLLMProxyAuthAndZeroLogDiscipline(t *testing.T) {
	env := setupLLMTestEnv(t)

	promptCanary := "CANARY_SECRET_SYSTEM_PROMPT_99182_NEVER_LOG"
	replyCanary := "CANARY_SECRET_COMPLETION_77412_NEVER_LOG"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer upstream_provider_secret_key" {
			http.Error(w, "bad upstream key", http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			http.Error(w, "wrong path: "+r.URL.Path, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", replyCanary)
		_ = rc.Flush()
		_, _ = fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":25,\"completion_tokens\":15}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		_ = rc.Flush()
	}))
	defer upstream.Close()

	var logSink lockedBuffer
	prevOut := log.Writer()
	log.SetOutput(&logSink)
	defer log.SetOutput(prevOut)

	tracker := llmproxy.NewQuotaTracker(llmproxy.QuotaLimits{
		AccountDailyTokens: 100_000,
		AgentDailyTokens:   100_000,
	}, time.Now)
	proxySvc, err := llmproxy.NewService(env.authSvc, tracker, llmproxy.Config{
		UpstreamBaseURL:   upstream.URL,
		UpstreamAPIKey:    "upstream_provider_secret_key",
		ChunkWriteTimeout: 2 * time.Second,
		Logger:            log.New(&logSink, "[llmproxy] ", 0),
	})
	if err != nil {
		t.Fatalf("llmproxy.NewService: %v", err)
	}

	mux := http.NewServeMux()
	proxySvc.RegisterRoutes(mux)
	hubSrv := httptest.NewServer(mux)
	defer hubSrv.Close()

	// 1. Unauthenticated caller -> 401
	reqUnauth, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/chat/completions", strings.NewReader(`{"model":"gpt-test"}`))
	respUnauth, err := http.DefaultClient.Do(reqUnauth)
	if err != nil {
		t.Fatalf("unauth Do: %v", err)
	}
	_ = respUnauth.Body.Close()
	if respUnauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated caller, got %d", respUnauth.StatusCode)
	}

	// 2. Authenticated streaming request with secret prompt/reply canaries
	reqBody := fmt.Sprintf(`{"model":"gpt-test","stream":true,"messages":[{"role":"system","content":%q}]}`, promptCanary)
	reqAuth, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/chat/completions", strings.NewReader(reqBody))
	reqAuth.Header.Set("Authorization", "Bearer "+env.bearerToken)
	reqAuth.Header.Set("Content-Type", "application/json")
	respAuth, err := http.DefaultClient.Do(reqAuth)
	if err != nil {
		t.Fatalf("auth Do: %v", err)
	}
	streamedBody, err := io.ReadAll(respAuth.Body)
	_ = respAuth.Body.Close()
	if err != nil {
		t.Fatalf("read streamed body: %v", err)
	}
	if respAuth.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d (%s)", respAuth.StatusCode, string(streamedBody))
	}
	if !strings.Contains(string(streamedBody), replyCanary) {
		t.Fatalf("expected streamed completion canary, got %q", string(streamedBody))
	}

	// Zero-log verification: neither prompt, completion, client bearer token, nor upstream key may appear in logs!
	capturedLogs := logSink.String()
	for _, forbidden := range []string{promptCanary, replyCanary, env.bearerToken, "upstream_provider_secret_key"} {
		if strings.Contains(capturedLogs, forbidden) {
			t.Fatalf("ZERO-LOG VIOLATION: found forbidden secret %q in logs: %s", forbidden, capturedLogs)
		}
	}

	// 3. Revoked device -> 403 Forbidden
	if err := env.st.UpsertDevice(context.Background(), store.Device{
		AgentID:          env.agentID,
		DeviceID:         env.deviceID,
		AccountID:        env.accountID,
		Ed25519PubKeyHex: strings.Repeat("22", 32),
		XWingPubKeyHex:   strings.Repeat("33", 32),
		Revoked:          true,
		CreatedAtMs:      time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("revoke device: %v", err)
	}
	reqRevoked, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/chat/completions", strings.NewReader(`{"model":"gpt-test"}`))
	reqRevoked.Header.Set("Authorization", "Bearer "+env.bearerToken)
	respRevoked, err := http.DefaultClient.Do(reqRevoked)
	if err != nil {
		t.Fatalf("revoked Do: %v", err)
	}
	_ = respRevoked.Body.Close()
	if respRevoked.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for revoked device, got %d", respRevoked.StatusCode)
	}
}

func TestLLMProxySlowClientWriteTimeoutCancelsUpstreamAndRefunds(t *testing.T) {
	env := setupLLMTestEnv(t)

	upstreamCanceled := make(chan struct{})
	var upstreamChunksEmitted atomic.Int64

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(upstreamCanceled)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		bigDelta := strings.Repeat("X", 32*1024) // 32 KiB per SSE event to quickly saturate stalled client socket buffer
		for i := 0; i < 5000; i++ {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			if _, err := fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", bigDelta); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
			upstreamChunksEmitted.Add(1)
			time.Sleep(5 * time.Millisecond)
		}
	}))
	defer upstream.Close()

	tracker := llmproxy.NewQuotaTracker(llmproxy.QuotaLimits{
		AccountDailyTokens: 5_000_000,
		AgentDailyTokens:   5_000_000,
	}, time.Now)
	proxySvc, err := llmproxy.NewService(env.authSvc, tracker, llmproxy.Config{
		UpstreamBaseURL:   upstream.URL,
		UpstreamAPIKey:    "sk-test",
		ChunkWriteTimeout: 80 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("llmproxy.NewService: %v", err)
	}

	mux := http.NewServeMux()
	proxySvc.RegisterRoutes(mux)
	hubSrv := httptest.NewServer(mux)
	defer hubSrv.Close()

	// Connect with raw TCP socket and tiny OS receive buffer, read HTTP 200 header, then stall completely!
	uAddr := strings.TrimPrefix(hubSrv.URL, "http://")
	tcpConn, err := net.Dial("tcp", uAddr)
	if err != nil {
		t.Fatalf("dial hub tcp: %v", err)
	}
	defer func() { _ = tcpConn.Close() }()
	if tc, ok := tcpConn.(*net.TCPConn); ok {
		_ = tc.SetReadBuffer(4096)
	}

	bodyJSON := `{"model":"gpt-test","stream":true,"max_tokens":400000,"messages":[{"role":"user","content":"stream forever"}]}`
	rawHTTPReq := fmt.Sprintf(
		"POST /v1/llm/v1/chat/completions HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
		uAddr, env.bearerToken, len(bodyJSON), bodyJSON,
	)
	if _, err := tcpConn.Write([]byte(rawHTTPReq)); err != nil {
		t.Fatalf("write raw HTTP req: %v", err)
	}

	// Read just the first 128 bytes (HTTP/1.1 200 OK headers) and then freeze reading!
	small := make([]byte, 128)
	if _, err := io.ReadFull(tcpConn, small); err != nil {
		t.Fatalf("read initial response header: %v", err)
	}
	if !strings.HasPrefix(string(small), "HTTP/1.1 200") {
		t.Fatalf("expected HTTP/1.1 200, got %q", string(small))
	}

	// Upstream MUST be canceled within 2s due to ResponseController SetWriteDeadline timeout!
	select {
	case <-upstreamCanceled:
	case <-time.After(2500 * time.Millisecond):
		t.Fatalf("slow stalled SSE client did NOT cancel upstream within deadline (chunks=%d)", upstreamChunksEmitted.Load())
	}

	// Wait briefly for proxy handler defer settlement to complete
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if tracker.AgentSnapshot(env.agentID).ReservedTokens == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	snap := tracker.AgentSnapshot(env.agentID)
	if snap.ReservedTokens != 0 {
		t.Fatalf("expected ReservedTokens == 0 after cancellation settlement, got %d", snap.ReservedTokens)
	}
	if snap.UsedDailyTokens <= 0 || snap.UsedDailyTokens >= 400_000 {
		t.Fatalf("expected partial consumed tokens settled (0 < used < 400000), got %d", snap.UsedDailyTokens)
	}
}

func TestLLMProxyTwoPhaseMultimodalAndReasoningQuotaSettlement(t *testing.T) {
	env := setupLLMTestEnv(t)

	inFlightStarted := make(chan struct{})
	releaseStream := make(chan struct{})
	var callNum atomic.Int32

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := callNum.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		if n == 1 {
			_, _ = fmt.Fprint(w, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":500}}}\n\n")
			_ = rc.Flush()
			close(inFlightStarted)
			<-releaseStream
			_, _ = fmt.Fprint(w, "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":200}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			_ = rc.Flush()
			return
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":3300}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		_ = rc.Flush()
	}))
	defer upstream.Close()

	// Daily limit: 5,000 tokens
	tracker := llmproxy.NewQuotaTracker(llmproxy.QuotaLimits{
		AccountDailyTokens: 5_000,
		AccountTotalTokens: 5_000,
		AgentDailyTokens:   5_000,
		AgentTotalTokens:   5_000,
	}, time.Now)

	// Verify multimodal + reasoning estimate significantly exceeds plain text estimate
	plainEst := llmproxy.EstimateRequestTokens([]byte(`{"model":"claude","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}`))
	fakeB64Image := strings.Repeat("A", 16*1024)
	fakeB64Audio := strings.Repeat("B", 8*1024)
	multimodalReq := fmt.Sprintf(
		`{"model":"claude","max_tokens":512,"thinking":{"type":"enabled","budget_tokens":2048},"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","data":%q}},{"type":"input_audio","input_audio":{"data":%q,"format":"wav"}},{"type":"text","text":"describe"}]}]}`,
		fakeB64Image, fakeB64Audio,
	)
	mmEst := llmproxy.EstimateRequestTokens([]byte(multimodalReq))
	if mmEst < plainEst+2048+500 {
		t.Fatalf("expected multimodal + reasoning estimate (%d) >> plain estimate (%d) + 2548", mmEst, plainEst)
	}

	proxySvc, err := llmproxy.NewService(env.authSvc, tracker, llmproxy.Config{
		UpstreamBaseURL:   upstream.URL,
		UpstreamAPIKey:    "sk-test",
		ChunkWriteTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("llmproxy.NewService: %v", err)
	}
	mux := http.NewServeMux()
	proxySvc.RegisterRoutes(mux)
	hubSrv := httptest.NewServer(mux)
	defer hubSrv.Close()

	// Start Request 1 (pre-reserves ~3500-4500 tokens out of 5000)
	errCh := make(chan error, 1)
	go func() {
		req1, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/messages", strings.NewReader(multimodalReq))
		req1.Header.Set("Authorization", "Bearer "+env.bearerToken)
		resp1, err := http.DefaultClient.Do(req1)
		if err != nil {
			errCh <- err
			return
		}
		_, _ = io.ReadAll(resp1.Body)
		_ = resp1.Body.Close()
		if resp1.StatusCode != http.StatusOK {
			errCh <- fmt.Errorf("req1 status %d", resp1.StatusCode)
			return
		}
		errCh <- nil
	}()

	<-inFlightStarted

	// While Request 1 is in flight holding its pre-reservation, a second large request MUST hit 429 Too Many Requests!
	reqConcurrent, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/messages", strings.NewReader(multimodalReq))
	reqConcurrent.Header.Set("Authorization", "Bearer "+env.bearerToken)
	respConcurrent, err := http.DefaultClient.Do(reqConcurrent)
	if err != nil {
		t.Fatalf("concurrent Do: %v", err)
	}
	_ = respConcurrent.Body.Close()
	if respConcurrent.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests while pre-reservation saturates quota, got %d", respConcurrent.StatusCode)
	}

	// Release Request 1 -> settles exact 500 + 200 = 700 tokens, refunding unused ~3000+ reservation!
	close(releaseStream)
	if err := <-errCh; err != nil {
		t.Fatalf("req1 failed: %v", err)
	}

	snapAfter1 := tracker.AgentSnapshot(env.agentID)
	if snapAfter1.ReservedTokens != 0 || snapAfter1.UsedDailyTokens != 700 {
		t.Fatalf("expected exact settlement of 700 tokens (0 reserved), got %+v", snapAfter1)
	}

	// Request 2: now succeeds because unused reservation was refunded! Consumes 4,300 tokens -> total 5,000 == cap!
	req2Body := `{"model":"gpt-test","max_tokens":500,"messages":[{"role":"user","content":"follow up"}]}`
	req2, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/chat/completions", strings.NewReader(req2Body))
	req2.Header.Set("Authorization", "Bearer "+env.bearerToken)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("req2 Do: %v", err)
	}
	_, _ = io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected req2 to succeed after refund, got %d", resp2.StatusCode)
	}

	// Request 3: quota is now 5,000/5,000 exhausted -> 429 Too Many Requests!
	req3, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/chat/completions", strings.NewReader(req2Body))
	req3.Header.Set("Authorization", "Bearer "+env.bearerToken)
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatalf("req3 Do: %v", err)
	}
	_ = resp3.Body.Close()
	if resp3.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests after quota exhausted, got %d", resp3.StatusCode)
	}
}

func TestLLMProxySpecialTokensAndSplitUTF8Resilience(t *testing.T) {
	env := setupLLMTestEnv(t)

	largeToolArg := strings.Repeat("Z", 96*1024) // > 64 KiB bufio.Scanner default token limit!
	var expectedSSE bytes.Buffer
	fmt.Fprintf(&expectedSSE, "data: {\"choices\":[{\"delta\":{\"content\":\"<|endoftext|><|fim_prefix|>羽蛇神🐍\"}}]}\n\n")
	fmt.Fprintf(&expectedSSE, "data: {\"choices\":[{\"delta\":{\"content\":\"tricky nested data: [DONE] and <|im_end|>\"}}]}\n\n")
	fmt.Fprintf(&expectedSSE, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"arguments\":%q}}]}}]}\n\n", largeToolArg)
	fmt.Fprintf(&expectedSSE, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":40,\"completion_tokens\":310}}\n\n")
	fmt.Fprintf(&expectedSSE, "data: [DONE]\n\n")
	fullPayload := expectedSSE.Bytes()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		rc := http.NewResponseController(w)
		// Drip-feed first 256 bytes in 3-byte chunks to split UTF-8 runes ("羽蛇神🐍") and "<|endoftext|>" across reads!
		splitBoundary := min(256, len(fullPayload))
		for i := 0; i < splitBoundary; i += 3 {
			end := min(i+3, splitBoundary)
			_, _ = w.Write(fullPayload[i:end])
			_ = rc.Flush()
		}
		_, _ = w.Write(fullPayload[splitBoundary:])
		_ = rc.Flush()
	}))
	defer upstream.Close()

	tracker := llmproxy.NewQuotaTracker(llmproxy.QuotaLimits{
		AccountDailyTokens: 1_000_000,
		AgentDailyTokens:   1_000_000,
	}, time.Now)
	proxySvc, err := llmproxy.NewService(env.authSvc, tracker, llmproxy.Config{
		UpstreamBaseURL:   upstream.URL,
		UpstreamAPIKey:    "sk-test",
		ChunkWriteTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("llmproxy.NewService: %v", err)
	}

	mux := http.NewServeMux()
	proxySvc.RegisterRoutes(mux)
	hubSrv := httptest.NewServer(mux)
	defer hubSrv.Close()

	req, _ := http.NewRequest("POST", hubSrv.URL+"/v1/llm/v1/chat/completions", strings.NewReader(`{"model":"gpt-test","stream":true,"messages":[{"role":"user","content":"go"}]}`))
	req.Header.Set("Authorization", "Bearer "+env.bearerToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	gotBytes, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	if !bytes.Equal(gotBytes, fullPayload) {
		t.Fatalf("special-token / split-UTF8 stream corrupted: got len=%d want len=%d", len(gotBytes), len(fullPayload))
	}
	snap := tracker.AgentSnapshot(env.agentID)
	if snap.UsedDailyTokens != 350 {
		t.Fatalf("expected settled usage 350 (40+310) after oversized frame + [DONE], got %+v", snap)
	}
}

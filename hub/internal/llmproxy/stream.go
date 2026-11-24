// SPDX-License-Identifier: AGPL-3.0-only

package llmproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"quetzalcoatl-hub/internal/auth"
)

const (
	defaultChunkWriteTimeout = 15 * time.Second
	defaultMaxRequestBytes   = 32 * 1024 * 1024
	streamCopyBufBytes       = 16 * 1024
	maxUsageLineBufBytes     = 64 * 1024
)

type Config struct {
	UpstreamBaseURL   string
	UpstreamAPIKey    string
	ChunkWriteTimeout time.Duration
	MaxRequestBytes   int64
	HTTPClient        *http.Client
	Logger            *log.Logger
}

type Service struct {
	auth   *auth.Service
	quota  *QuotaTracker
	cfg    Config
	client *http.Client
}

func NewService(authSvc *auth.Service, quota *QuotaTracker, cfg Config) (*Service, error) {
	if authSvc == nil {
		return nil, errors.New("auth service is required")
	}
	if quota == nil {
		quota = NewQuotaTracker(QuotaLimits{}, time.Now)
	}
	if cfg.ChunkWriteTimeout <= 0 {
		cfg.ChunkWriteTimeout = defaultChunkWriteTimeout
	}
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = defaultMaxRequestBytes
	}
	cfg.UpstreamBaseURL = strings.TrimRight(strings.TrimSpace(cfg.UpstreamBaseURL), "/")

	client := cfg.HTTPClient
	if client == nil {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.ResponseHeaderTimeout = 30 * time.Second
		client = &http.Client{
			Transport: tr,
			// Overall Timeout MUST be 0 so long-running SSE streams are governed per-chunk rather than killed globally.
			Timeout: 0,
		}
	}

	return &Service{
		auth:   authSvc,
		quota:  quota,
		cfg:    cfg,
		client: client,
	}, nil
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/v1/llm/", s.handleProxy)
}

func writeProxyJSONError(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"code":   code,
		"detail": detail,
	})
}

func (s *Service) handleProxy(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}

	agentID := principal.AgentID
	if hdrAgent := strings.TrimSpace(r.Header.Get("X-Quetzalcoatl-Agent-ID")); hdrAgent != "" && hdrAgent != principal.AgentID {
		if _, _, ownerOK := s.auth.RequireAgentOwner(w, r, hdrAgent); !ownerOK {
			return
		}
		agentID = hdrAgent
	}

	if s.cfg.UpstreamBaseURL == "" {
		writeProxyJSONError(w, http.StatusServiceUnavailable, "UPSTREAM_UNCONFIGURED", "hub llm proxy upstream is not configured")
		return
	}

	limitedBody := http.MaxBytesReader(w, r.Body, s.cfg.MaxRequestBytes)
	defer limitedBody.Close()
	reqBytes, err := io.ReadAll(limitedBody)
	if err != nil {
		writeProxyJSONError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body exceeds limit")
		return
	}

	inputEstimate, outBudget := EstimateInputTokens(reqBytes)
	totalEstimate := inputEstimate + outBudget

	resv, err := s.quota.Reserve(principal.AccountID, agentID, totalEstimate)
	if err != nil {
		if errors.Is(err, ErrQuotaExceeded) {
			w.Header().Set("Retry-After", "60")
			writeProxyJSONError(w, http.StatusTooManyRequests, "QUOTA_EXCEEDED", "token quota exceeded")
			return
		}
		writeProxyJSONError(w, http.StatusInternalServerError, "QUOTA_ERROR", "quota check failed")
		return
	}
	// Safety net: if we exit before explicit settlement, refund 100% of reservation.
	defer resv.Settle(0)

	subPath := strings.TrimPrefix(r.URL.Path, "/v1/llm")
	if !strings.HasPrefix(subPath, "/") {
		subPath = "/" + subPath
	}
	targetURL := s.cfg.UpstreamBaseURL + subPath
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	upstreamCtx, cancelUpstream := context.WithCancel(r.Context())
	defer cancelUpstream()

	upReq, err := http.NewRequestWithContext(upstreamCtx, r.Method, targetURL, bytes.NewReader(reqBytes))
	if err != nil {
		writeProxyJSONError(w, http.StatusBadRequest, "INVALID_UPSTREAM_REQUEST", "invalid request path")
		return
	}
	// Release reference to reqBytes slice as soon as Reader holds it; never log reqBytes!
	reqBytes = nil

	copySafeRequestHeaders(upReq.Header, r.Header)
	if s.cfg.UpstreamAPIKey != "" {
		upReq.Header.Set("Authorization", "Bearer "+s.cfg.UpstreamAPIKey)
		if strings.HasPrefix(subPath, "/v1/messages") && upReq.Header.Get("X-Api-Key") == "" {
			upReq.Header.Set("X-Api-Key", s.cfg.UpstreamAPIKey)
		}
	}

	upResp, err := s.client.Do(upReq)
	if err != nil {
		writeProxyJSONError(w, http.StatusBadGateway, "UPSTREAM_UNAVAILABLE", "upstream connection failed")
		return
	}
	defer func() { _ = upResp.Body.Close() }()

	rc := http.NewResponseController(w)

	// Upstream error before generation: refund 100% of reserved tokens and forward status without logging body.
	if upResp.StatusCode >= http.StatusBadRequest {
		if ct := upResp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(upResp.StatusCode)
		_ = setChunkDeadline(rc, s.cfg.ChunkWriteTimeout)
		_, _ = io.CopyN(w, upResp.Body, 64*1024)
		resv.Settle(0)
		s.logOpaqueMetric(r.Method, upResp.StatusCode, 0, time.Since(started))
		return
	}

	copySafeResponseHeaders(w.Header(), upResp.Header)
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(upResp.StatusCode)
	if err := setChunkDeadline(rc, s.cfg.ChunkWriteTimeout); err != nil {
		cancelUpstream()
		resv.Settle(0)
		return
	}
	if err := flushResponse(rc); err != nil {
		cancelUpstream()
		resv.Settle(0)
		return
	}

	isSSE := strings.Contains(strings.ToLower(upResp.Header.Get("Content-Type")), "text/event-stream")
	var observer sseUsageObserver
	observer.init(isSSE)

	buf := make([]byte, streamCopyBufBytes)
	var streamedBytes int64
	streamAborted := false

	for {
		n, readErr := upResp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			observer.feed(chunk)

			if dlErr := setChunkDeadline(rc, s.cfg.ChunkWriteTimeout); dlErr != nil {
				streamAborted = true
				cancelUpstream()
				_ = upResp.Body.Close()
				break
			}
			written, writeErr := w.Write(chunk)
			streamedBytes += int64(written)
			flushErr := flushResponse(rc)
			if writeErr != nil || flushErr != nil {
				// Slow or disconnected client: immediately cancel upstream and stop reading!
				streamAborted = true
				cancelUpstream()
				_ = upResp.Body.Close()
				break
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				streamAborted = true
			}
			break
		}
	}

	observer.finish()
	settled := observer.settledTokens(inputEstimate, streamedBytes, totalEstimate, streamAborted)
	resv.Settle(settled)
	// Reset connection write deadline after streaming finishes cleanly
	_ = rc.SetWriteDeadline(time.Time{})
	s.logOpaqueMetric(r.Method, upResp.StatusCode, settled, time.Since(started))
}

func setChunkDeadline(rc *http.ResponseController, timeout time.Duration) error {
	err := rc.SetWriteDeadline(time.Now().Add(timeout))
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

func flushResponse(rc *http.ResponseController) error {
	err := rc.Flush()
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

func copySafeRequestHeaders(dst, src http.Header) {
	for _, k := range []string{
		"Content-Type",
		"Accept",
		"Anthropic-Version",
		"Anthropic-Beta",
		"OpenAI-Beta",
	} {
		for _, v := range src.Values(k) {
			dst.Add(k, v)
		}
	}
}

func copySafeResponseHeaders(dst, src http.Header) {
	for _, k := range []string{
		"Content-Type",
		"Cache-Control",
		"X-Request-Id",
	} {
		if v := src.Get(k); v != "" {
			dst.Set(k, v)
		}
	}
}

func (s *Service) logOpaqueMetric(method string, status int, settledTokens int64, dur time.Duration) {
	if s.cfg.Logger == nil {
		return
	}
	// Strictly zero prompt/response/path/credential logging: only method, HTTP status, settled token count, and latency!
	s.cfg.Logger.Printf("llm_proxy method=%s status=%d settled_tokens=%d duration_ms=%d", method, status, settledTokens, dur.Milliseconds())
}

// --- Bounded O(1)-memory SSE & JSON usage observer (immune to oversized lines & special tokens) ---

type sseUsageObserver struct {
	isSSE          bool
	lineBuf        []byte
	lineOversized  bool
	jsonBuf        []byte
	jsonOversized  bool
	hasExactInput  bool
	hasExactOutput bool
	exactInput     int64
	exactOutput    int64
	exactTotal     int64
}

func (o *sseUsageObserver) init(isSSE bool) {
	o.isSSE = isSSE
}

func (o *sseUsageObserver) feed(chunk []byte) {
	if !o.isSSE {
		if !o.jsonOversized {
			if len(o.jsonBuf)+len(chunk) <= maxUsageLineBufBytes {
				o.jsonBuf = append(o.jsonBuf, chunk...)
			} else {
				o.jsonBuf = nil
				o.jsonOversized = true
			}
		}
		return
	}

	for len(chunk) > 0 {
		nlIdx := bytes.IndexByte(chunk, '\n')
		if nlIdx < 0 {
			if !o.lineOversized {
				if len(o.lineBuf)+len(chunk) <= maxUsageLineBufBytes {
					o.lineBuf = append(o.lineBuf, chunk...)
				} else {
					o.lineBuf = o.lineBuf[:0]
					o.lineOversized = true
				}
			}
			return
		}

		part := chunk[:nlIdx]
		chunk = chunk[nlIdx+1:]
		if !o.lineOversized {
			if len(o.lineBuf)+len(part) <= maxUsageLineBufBytes {
				o.lineBuf = append(o.lineBuf, part...)
				o.inspectSSELine(o.lineBuf)
			}
		}
		o.lineBuf = o.lineBuf[:0]
		o.lineOversized = false
	}
}

func (o *sseUsageObserver) finish() {
	if !o.isSSE {
		if !o.jsonOversized && len(o.jsonBuf) > 0 {
			o.inspectUsageJSON(o.jsonBuf)
		}
		o.jsonBuf = nil
		return
	}
	if !o.lineOversized && len(o.lineBuf) > 0 {
		o.inspectSSELine(o.lineBuf)
	}
	o.lineBuf = nil
}

func (o *sseUsageObserver) inspectSSELine(rawLine []byte) {
	line := bytes.TrimSpace(rawLine)
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(line[len("data:"):])
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	// Fast skip: only parse JSON lines that actually mention "usage"
	if !bytes.Contains(payload, []byte(`"usage"`)) {
		return
	}
	o.inspectUsageJSON(payload)
}

func (o *sseUsageObserver) inspectUsageJSON(payload []byte) {
	var env struct {
		Usage *struct {
			PromptTokens     *int64 `json:"prompt_tokens"`
			CompletionTokens *int64 `json:"completion_tokens"`
			TotalTokens      *int64 `json:"total_tokens"`
			InputTokens      *int64 `json:"input_tokens"`
			OutputTokens     *int64 `json:"output_tokens"`
		} `json:"usage"`
		Message *struct {
			Usage *struct {
				InputTokens              *int64 `json:"input_tokens"`
				CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
				CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
				OutputTokens             *int64 `json:"output_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return
	}
	if u := env.Usage; u != nil {
		if u.TotalTokens != nil && *u.TotalTokens > 0 {
			o.exactTotal = *u.TotalTokens
		}
		if u.PromptTokens != nil {
			o.exactInput = *u.PromptTokens
			o.hasExactInput = true
		}
		if u.CompletionTokens != nil {
			o.exactOutput = *u.CompletionTokens
			o.hasExactOutput = true
		}
		if u.InputTokens != nil {
			o.exactInput = *u.InputTokens
			o.hasExactInput = true
		}
		if u.OutputTokens != nil {
			o.exactOutput = *u.OutputTokens
			o.hasExactOutput = true
		}
	}
	if env.Message != nil && env.Message.Usage != nil {
		mu := env.Message.Usage
		var inSum int64
		hasIn := false
		if mu.InputTokens != nil {
			inSum += *mu.InputTokens
			hasIn = true
		}
		if mu.CacheCreationInputTokens != nil {
			inSum += *mu.CacheCreationInputTokens
			hasIn = true
		}
		if mu.CacheReadInputTokens != nil {
			inSum += *mu.CacheReadInputTokens
			hasIn = true
		}
		if hasIn {
			o.exactInput = inSum
			o.hasExactInput = true
		}
		if mu.OutputTokens != nil {
			o.exactOutput = *mu.OutputTokens
			o.hasExactOutput = true
		}
	}
}

func (o *sseUsageObserver) settledTokens(inputEst, streamedBytes, reservedMax int64, aborted bool) int64 {
	if !aborted {
		if o.exactTotal > 0 {
			return o.exactTotal
		}
		if o.hasExactInput && o.hasExactOutput {
			return o.exactInput + o.exactOutput
		}
	}
	inTok := inputEst
	if o.hasExactInput {
		inTok = o.exactInput
	}
	if o.hasExactOutput && !aborted {
		return inTok + o.exactOutput
	}
	if streamedBytes <= 0 {
		return 0
	}
	approxOut := max(1, (streamedBytes+7)/8)
	settled := inTok + approxOut
	if aborted && reservedMax > 0 && settled >= reservedMax {
		settled = max(1, reservedMax-1)
	}
	return settled
}

// SPDX-License-Identifier: AGPL-3.0-only

// Package lease 同时承载 Router 两态围栏租约与公网 Webhook 的零知识 HPKE 入站。
//
// Webhook 入站铁律（AGENTS.md 防坑规范 #18）：
//  1. 平台 HMAC 只在内存中对原始请求体验签；
//  2. 验签通过后立刻用 Agent 的 ChannelIngressKey（X-Wing MLKEM768X25519, KEM 0x647a,
//     HKDF-SHA256, ChaCha20-Poly1305）密封，AAD 绑定 agent_id/channel/received_at_ms；
//  3. 只有 enc/密文/AAD 允许落盘，平台明文正文绝不写磁盘、绝不进日志。
package lease

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

const (
	// ChannelIngressSlotType 是 Agent 的 ChannelIngressKey 公钥槽位（公钥可公开存放）。
	ChannelIngressSlotType = "channel_ingress"
	// WebhookIngressInfo 与 spec/vectors/hpke_xwing.json 的 info_utf8 完全一致。
	WebhookIngressInfo = "quetzalcoatl/v2/webhook-ingress"
	// maxWebhookBodyBytes 是单条公网 Webhook 的硬上限（超出返回 413）。
	maxWebhookBodyBytes = 256 * 1024
	// defaultWebhookQueueLimit 是每 Agent 的密文队列上限。
	defaultWebhookQueueLimit = 1024
)

// WebhookIngressConfig 配置零知识入站。
type WebhookIngressConfig struct {
	// Secrets 是各通道平台 HMAC 密钥；生产从 QUETZALCOATL_HOME/secrets/* 或环境变量加载。
	// 该映射绝不序列化、绝不打印。
	Secrets map[string][]byte
	// MaxBodyBytes 默认 256 KiB。
	MaxBodyBytes int64
	// MaxQueuePerAgent 默认 1024，<=0 表示不限制。
	MaxQueuePerAgent int
	// DeterministicSeed 仅供测试重现 spec 向量；生产必须为 nil（使用 CSPRNG）。
	DeterministicSeed []byte
}

// WebhookIngressService 是公网 Webhook 的零知识入站端点。
type WebhookIngressService struct {
	store store.Store
	cfg   WebhookIngressConfig
	clock func() time.Time
}

// NewWebhookIngressService 构造入站服务。
func NewWebhookIngressService(st store.Store, cfg WebhookIngressConfig, clock func() time.Time) (*WebhookIngressService, error) {
	if st == nil {
		return nil, errors.New("webhook ingress requires a store")
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = maxWebhookBodyBytes
	}
	if cfg.MaxQueuePerAgent == 0 {
		cfg.MaxQueuePerAgent = defaultWebhookQueueLimit
	}
	if cfg.DeterministicSeed != nil && len(cfg.DeterministicSeed) != 64 {
		return nil, errors.New("deterministic webhook seal seed must be 64 bytes")
	}
	if clock == nil {
		clock = time.Now
	}
	return &WebhookIngressService{store: st, cfg: cfg, clock: clock}, nil
}

// RegisterRoutes 挂载 `POST /v1/webhook/{agent_id}/{channel}`。
func (s *WebhookIngressService) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/webhook/{agent_id}/{channel}", s.handleIngress)
}

func writeWebhookJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func webhookError(w http.ResponseWriter, status int, code, detail string) {
	writeWebhookJSON(w, status, map[string]string{"code": code, "detail": detail})
}

func constantTimeEqualString(a, b []byte) bool {
	return hmac.Equal(a, b)
}

// verifyGenericHMAC 对原始请求体做常数时间 HMAC-SHA256 校验。
func verifyGenericHMAC(secret, body []byte, headerValue string) bool {
	value := strings.TrimSpace(headerValue)
	if value == "" {
		return false
	}
	value = strings.TrimPrefix(value, "sha256=")
	want, err := hex.DecodeString(value)
	if err != nil || len(want) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return constantTimeEqualString(mac.Sum(nil), want)
}

func withinSkew(raw string, now time.Time, maxSkew time.Duration) bool {
	ts, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return false
	}
	if ts > 1_000_000_000_000 { // 毫秒时间戳
		ts /= 1000
	}
	delta := now.Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	return delta <= int64(maxSkew.Seconds())
}

// verifyFeishu 校验 `X-Lark-Signature = sha256(timestamp + nonce + secret + body)`。
func verifyFeishu(r *http.Request, body, secret []byte, now time.Time) bool {
	ts := r.Header.Get("X-Lark-Request-Timestamp")
	nonce := r.Header.Get("X-Lark-Request-Nonce")
	sigHex := r.Header.Get("X-Lark-Signature")
	if ts == "" || nonce == "" || sigHex == "" {
		return verifyGenericHMAC(secret, body, r.Header.Get("X-QZ-Signature"))
	}
	if !withinSkew(ts, now, 5*time.Minute) {
		return false
	}
	want, err := hex.DecodeString(sigHex)
	if err != nil || len(want) != sha256.Size {
		return false
	}
	h := sha256.New()
	_, _ = h.Write([]byte(ts))
	_, _ = h.Write([]byte(nonce))
	_, _ = h.Write(secret)
	_, _ = h.Write(body)
	return constantTimeEqualString(h.Sum(nil), want)
}

// verifyDingTalk 校验 `sign = base64(hmac_sha256(secret, timestamp + "\n" + secret))`。
func verifyDingTalk(r *http.Request, body, secret []byte, now time.Time) bool {
	ts := r.Header.Get("timestamp")
	sign := r.Header.Get("sign")
	if ts == "" || sign == "" {
		return verifyGenericHMAC(secret, body, r.Header.Get("X-QZ-Signature"))
	}
	if !withinSkew(ts, now, 5*time.Minute) {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(ts))
	_, _ = mac.Write([]byte("\n"))
	_, _ = mac.Write(secret)
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(sign), []byte(want))
}

// verifyWeCom 校验 SHA1(msg_signature) over sorted(token,timestamp,nonce,encrypt)。
func verifyWeCom(r *http.Request, body, secret []byte, _ time.Time) bool {
	q := r.URL.Query()
	ts := q.Get("timestamp")
	nonce := q.Get("nonce")
	sig := q.Get("msg_signature")
	encrypt := xmlTag(body, "Encrypt")
	if ts == "" || nonce == "" || sig == "" || encrypt == "" {
		return false
	}
	items := []string{string(secret), ts, nonce, encrypt}
	sort.Strings(items)
	h := sha1.New()
	_, _ = h.Write([]byte(strings.Join(items, "")))
	return hmac.Equal([]byte(strings.ToLower(sig)), []byte(hex.EncodeToString(h.Sum(nil))))
}

// verifyTelegram 校验固定 secret token 请求头。
func verifyTelegram(r *http.Request, _ []byte, secret []byte, _ time.Time) bool {
	got := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
	if got == "" {
		return false
	}
	return hmac.Equal([]byte(got), secret)
}

func (s *WebhookIngressService) verifyPlatformRequest(r *http.Request, channel string, body, secret []byte) bool {
	switch channel {
	case "feishu":
		return verifyFeishu(r, body, secret, s.clock())
	case "dingtalk":
		return verifyDingTalk(r, body, secret, s.clock())
	case "wecom":
		return verifyWeCom(r, body, secret, s.clock())
	case "telegram":
		return verifyTelegram(r, body, secret, s.clock())
	default:
		sig := r.Header.Get("X-QZ-Signature")
		if sig == "" {
			sig = r.Header.Get("X-Hub-Signature-256")
		}
		return verifyGenericHMAC(secret, body, sig)
	}
}

func xmlTag(body []byte, tag string) string {
	text := string(body)
	open := "<" + tag + ">"
	close := "</" + tag + ">"
	start := strings.Index(text, open)
	if start < 0 {
		return ""
	}
	rest := text[start+len(open):]
	end := strings.Index(rest, close)
	if end < 0 {
		return ""
	}
	value := strings.TrimSpace(rest[:end])
	value = strings.TrimPrefix(value, "<![CDATA[")
	value = strings.TrimSuffix(value, "]]>")
	return strings.TrimSpace(value)
}

func extractEventIDForChannel(channel string, body []byte) string {
	if channel == "wecom" {
		if id := xmlTag(body, "MsgId"); id != "" {
			return id
		}
		if id := xmlTag(body, "EventKey"); id != "" {
			return id
		}
		if encrypted := xmlTag(body, "Encrypt"); encrypted != "" {
			sum := sha256.Sum256([]byte(encrypted))
			return hex.EncodeToString(sum[:])
		}
	}
	return extractEventID(body)
}

func extractEventID(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	for _, key := range []string{"event_id", "update_id", "eventId", "msgId", "id"} {
		if v, ok := raw[key]; ok {
			switch t := v.(type) {
			case string:
				if strings.TrimSpace(t) != "" {
					return t
				}
			case float64:
				return strings.TrimRight(strings.TrimRight(jsonNumber(t), "0"), ".")
			}
		}
	}
	if header, ok := raw["header"].(map[string]any); ok {
		if v, ok := header["event_id"].(string); ok && strings.TrimSpace(v) != "" {
			return v
		}
	}
	if event, ok := raw["event"].(map[string]any); ok {
		if v, ok := event["id"].(string); ok && strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func jsonNumber(f float64) string {
	b, err := json.Marshal(f)
	if err != nil {
		return ""
	}
	return string(b)
}

func (s *WebhookIngressService) ingressPublicKey(agentID string) ([auth.XWingPKLen]byte, bool, error) {
	var pk [auth.XWingPKLen]byte
	slot, err := s.store.GetKeySlot(context.Background(), agentID, ChannelIngressSlotType)
	if errors.Is(err, store.ErrNotFound) {
		return pk, false, nil
	}
	if err != nil {
		return pk, false, err
	}
	raw, decErr := hex.DecodeString(strings.TrimSpace(slot.CiphertextHex))
	if decErr != nil || len(raw) != auth.XWingPKLen {
		return pk, false, nil
	}
	copy(pk[:], raw)
	return pk, true, nil
}

func (s *WebhookIngressService) handleIngress(w http.ResponseWriter, r *http.Request) {
	agentID := strings.TrimSpace(r.PathValue("agent_id"))
	channel := strings.TrimSpace(r.PathValue("channel"))
	if agentID == "" || channel == "" {
		webhookError(w, http.StatusBadRequest, "INVALID_ID", "agent_id and channel are required")
		return
	}

	// 先按未知 Agent 返回 404，绝不泄露通道是否存在。
	if _, err := s.store.GetAgent(r.Context(), agentID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			webhookError(w, http.StatusNotFound, "AGENT_NOT_FOUND", "unknown agent")
			return
		}
		webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "agent lookup failed")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, s.cfg.MaxBodyBytes+1))
	_ = r.Body.Close()
	if err != nil {
		webhookError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "unreadable request body")
		return
	}
	if int64(len(body)) > s.cfg.MaxBodyBytes {
		webhookError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "webhook body exceeds limit")
		return
	}

	secret, ok := s.cfg.Secrets[channel]
	if !ok || len(secret) == 0 {
		// 未配置通道密钥一律视为认证失败，且绝不回显密钥状态细节。
		webhookError(w, http.StatusUnauthorized, "INVALID_SIGNATURE", "platform signature rejected")
		return
	}
	if !s.verifyPlatformRequest(r, channel, body, secret) {
		webhookError(w, http.StatusUnauthorized, "INVALID_SIGNATURE", "platform signature rejected")
		return
	}

	eventID := extractEventIDForChannel(channel, body)
	if eventID == "" {
		webhookError(w, http.StatusBadRequest, "INVALID_ID", "missing platform event id")
		return
	}

	pk, keyOK, keyErr := s.ingressPublicKey(agentID)
	if keyErr != nil {
		webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "ingress key lookup failed")
		return
	}
	if !keyOK {
		webhookError(w, http.StatusConflict, "CHANNEL_INGRESS_KEY_MISSING", "agent has no channel ingress key")
		return
	}

	eventIDHashRaw := sha256.Sum256([]byte(eventID))
	eventIDHash := hex.EncodeToString(eventIDHashRaw[:])

	receivedAtMs := s.clock().UnixMilli()
	aad, aadErr := json.Marshal(struct {
		AgentID      string `json:"agent_id"`
		Channel      string `json:"channel"`
		ReceivedAtMs int64  `json:"received_at_ms"`
	}{AgentID: agentID, Channel: channel, ReceivedAtMs: receivedAtMs})
	if aadErr != nil {
		webhookError(w, http.StatusInternalServerError, "SERIALIZATION_ERROR", "aad marshal failed")
		return
	}

	var sealed *auth.HPKESealedBox
	if s.cfg.DeterministicSeed != nil {
		var seed [64]byte
		copy(seed[:], s.cfg.DeterministicSeed)
		sealed, err = auth.HPKEXWingSealDeterministic(pk, []byte(WebhookIngressInfo), aad, body, seed)
	} else {
		sealed, err = auth.HPKEXWingSeal(pk, []byte(WebhookIngressInfo), aad, body)
	}
	if err != nil {
		// 绝不回显明文或密钥材料。
		webhookError(w, http.StatusInternalServerError, "HPKE_SEAL_FAILED", "webhook sealing failed")
		return
	}

	inserted, depth, enqueueErr := s.store.EnqueueWebhookIngress(r.Context(), store.WebhookIngressRecord{
		AgentID:       agentID,
		Channel:       channel,
		EventIDHash:   eventIDHash,
		HPKEEncHex:    hex.EncodeToString(sealed.Enc),
		CiphertextHex: hex.EncodeToString(sealed.Ciphertext),
		AADUTF8:       string(aad),
		ReceivedAtMs:  receivedAtMs,
		CreatedAtMs:   receivedAtMs,
	}, s.cfg.MaxQueuePerAgent)
	if enqueueErr != nil {
		if errors.Is(enqueueErr, store.ErrQuotaExceeded) {
			webhookError(w, http.StatusTooManyRequests, "INGRESS_QUEUE_FULL", "agent ingress queue is full")
			return
		}
		webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "enqueue failed")
		return
	}

	writeWebhookJSON(w, http.StatusAccepted, map[string]any{
		"status":    "accepted",
		"duplicate": !inserted,
		"depth":     depth,
	})
}

// OwnerAuthorizer 是 Webhook 消费者路由的最小鉴权契约；生产由 auth.Service 实现。
type OwnerAuthorizer interface {
	RequireAgentOwner(w http.ResponseWriter, r *http.Request, agentID string) (*auth.Principal, *store.Agent, bool)
}

// RegisterOwnerRoutes 挂载 Agent 所有者专属的队列读取/确认/状态路由。
// 所有路由复用 `RequireAgentOwner`，跨账号一律 403。
func (s *WebhookIngressService) RegisterOwnerRoutes(mux *http.ServeMux, authz OwnerAuthorizer) {
	mux.HandleFunc("GET /v1/webhook/{agent_id}/ingress", func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("agent_id"))
		if _, _, ok := authz.RequireAgentOwner(w, r, agentID); !ok {
			return
		}
		after := int64(0)
		if raw := strings.TrimSpace(r.URL.Query().Get("after")); raw != "" {
			parsed, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || parsed < 0 {
				webhookError(w, http.StatusBadRequest, "INVALID_ID", "after must be a non-negative cursor")
				return
			}
			after = parsed
		}
		limit := 100
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed <= 0 || parsed > 500 {
				webhookError(w, http.StatusBadRequest, "INVALID_ID", "limit must be 1..500")
				return
			}
			limit = parsed
		}
		rows, err := s.store.ListWebhookIngress(r.Context(), agentID, after, limit)
		if err != nil {
			webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "ingress list failed")
			return
		}
		events := make([]map[string]any, 0, len(rows))
		nextCursor := after
		for _, row := range rows {
			if row.IngressID > nextCursor {
				nextCursor = row.IngressID
			}
			events = append(events, map[string]any{
				"event_id":       row.EventIDHash,
				"cursor":         row.IngressID,
				"channel":        row.Channel,
				"received_at_ms": row.ReceivedAtMs,
				"enc_hex":        row.HPKEEncHex,
				"ciphertext_hex": row.CiphertextHex,
				"aad_json":       row.AADUTF8,
			})
		}
		depth, err := s.store.CountWebhookIngress(r.Context(), agentID)
		if err != nil {
			webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "ingress depth failed")
			return
		}
		writeWebhookJSON(w, http.StatusOK, map[string]any{
			"events":      events,
			"next_cursor": nextCursor,
			"queue_depth": depth,
		})
	})

	mux.HandleFunc("POST /v1/webhook/{agent_id}/ingress/ack", func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("agent_id"))
		if _, _, ok := authz.RequireAgentOwner(w, r, agentID); !ok {
			return
		}
		var req struct {
			EventIDs []string `json:"event_ids"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
			webhookError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "invalid JSON body")
			return
		}
		_ = r.Body.Close()
		hashes := make([]string, 0, len(req.EventIDs))
		for _, raw := range req.EventIDs {
			hash := strings.ToLower(strings.TrimSpace(raw))
			if len(hash) != 64 {
				webhookError(w, http.StatusBadRequest, "INVALID_ID", "event_id must be a 64-char hash")
				return
			}
			if _, err := hex.DecodeString(hash); err != nil {
				webhookError(w, http.StatusBadRequest, "INVALID_ID", "event_id must be hex")
				return
			}
			hashes = append(hashes, hash)
		}
		deleted, err := s.store.DeleteWebhookIngressByHashes(r.Context(), agentID, hashes)
		if err != nil {
			webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "ingress ack failed")
			return
		}
		depth, _ := s.store.CountWebhookIngress(r.Context(), agentID)
		writeWebhookJSON(w, http.StatusOK, map[string]any{
			"deleted":     deleted,
			"queue_depth": depth,
		})
	})

	mux.HandleFunc("GET /v1/webhook/{agent_id}/status", func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.PathValue("agent_id"))
		if _, _, ok := authz.RequireAgentOwner(w, r, agentID); !ok {
			return
		}
		keyID := ""
		registered := false
		slot, err := s.store.GetKeySlot(r.Context(), agentID, ChannelIngressSlotType)
		if err == nil {
			registered = true
			var meta map[string]any
			if json.Unmarshal([]byte(slot.MetadataJSON), &meta) == nil {
				if v, ok := meta["key_id"].(string); ok {
					keyID = v
				}
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "ingress key lookup failed")
			return
		}
		depth, err := s.store.CountWebhookIngress(r.Context(), agentID)
		if err != nil {
			webhookError(w, http.StatusInternalServerError, "STORAGE_ERROR", "ingress depth failed")
			return
		}
		writeWebhookJSON(w, http.StatusOK, map[string]any{
			"registered":  registered,
			"key_id":      keyID,
			"queue_depth": depth,
			"max_queue":   s.cfg.MaxQueuePerAgent,
		})
	})
}

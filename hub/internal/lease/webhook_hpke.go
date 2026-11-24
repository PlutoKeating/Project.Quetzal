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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
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

// verifyPlatformHMAC 对原始请求体做常数时间 HMAC-SHA256 校验。
// 支持 `X-QZ-Signature: sha256=<hex>` 与 GitHub/飞书风格 `X-Hub-Signature-256`。
func verifyPlatformHMAC(secret, body []byte, headerValue string) bool {
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

func extractEventID(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	for _, key := range []string{"event_id", "update_id", "eventId", "id"} {
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
	sig := r.Header.Get("X-QZ-Signature")
	if sig == "" {
		sig = r.Header.Get("X-Hub-Signature-256")
	}
	if !verifyPlatformHMAC(secret, body, sig) {
		webhookError(w, http.StatusUnauthorized, "INVALID_SIGNATURE", "platform signature rejected")
		return
	}

	eventID := extractEventID(body)
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

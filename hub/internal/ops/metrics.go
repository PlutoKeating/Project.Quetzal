// SPDX-License-Identifier: AGPL-3.0-only

// Package ops 提供 Hub 对外的两块「外壳」信息：给管理员的运行指标（/metrics）
// 与给客户端的元信息（/v1/meta）。两者只描述这台服务本身——活着吗、满了吗、
// 流量如何、要求什么版本——绝不输出任何账户、Agent 或设备的标识与内容。
package ops

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/netip"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"quetzalcoatl-hub/internal/relay"
	"quetzalcoatl-hub/internal/store"
)

const (
	metricsContentType = "text/plain; version=0.0.4; charset=utf-8"

	// MetricsTokenMinLen 挡住把令牌当开关填成 `1` / `true` 的误配置。
	MetricsTokenMinLen = 16
	metricsTokenMaxLen = 256

	defaultTotalsCacheTTL = 5 * time.Second
	totalsQueryTimeout    = 3 * time.Second
)

// proxyHopHeaders 是反向代理与隧道转发请求时会带上的头。未配置令牌时，带有其中任何
// 一个的请求一律拒绝：代理与 Hub 同机时，公网请求的连接远端同样是回环地址，只看远端
// 地址会把指标暴露给所有人。这些头只用来拒绝，从不用来放行。
var proxyHopHeaders = []string{
	"Forwarded",
	"X-Forwarded-For",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
	"X-Real-Ip",
	"Via",
	"Cf-Connecting-Ip",
	"True-Client-Ip",
}

// TotalsSource 是存储层的全库聚合入口，由 store.Store 满足。
type TotalsSource interface {
	Totals(ctx context.Context, nowMs int64) (store.Totals, error)
}

// MetricsConfig 配置 /metrics。
type MetricsConfig struct {
	Version   string
	StartedAt time.Time
	// Token 非空时要求 `Authorization: Bearer <Token>`；为空时只放行回环地址的直连请求。
	Token string
	// DefaultAgentQuotaBytes 是新建 Agent 的默认存储配额。
	DefaultAgentQuotaBytes int64
	Store                  TotalsSource
	Relay                  func() relay.Stats
	// QAD 为 nil 表示地址发现未启用。
	QAD   func() relay.QADStats
	Clock func() time.Time
	// TotalsCacheTTL 是存储聚合结果的复用时长，<=0 取默认值。
	TotalsCacheTTL time.Duration
}

// Metrics 以 Prometheus 文本格式输出运行指标。
type Metrics struct {
	cfg         MetricsConfig
	tokenDigest [sha256.Size]byte

	cacheTTL time.Duration

	mu          sync.Mutex
	cached      store.Totals
	cachedAt    time.Time
	cachePrimed bool
}

// ValidateMetricsToken 校验访问令牌的形状：空串表示不启用令牌。
func ValidateMetricsToken(token string) error {
	if token == "" {
		return nil
	}
	if len(token) < MetricsTokenMinLen || len(token) > metricsTokenMaxLen {
		return errors.New("metrics token must be " + strconv.Itoa(MetricsTokenMinLen) + "-" + strconv.Itoa(metricsTokenMaxLen) + " characters")
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x21 || token[i] > 0x7e {
			return errors.New("metrics token must be printable ASCII without spaces")
		}
	}
	return nil
}

func NewMetrics(cfg MetricsConfig) (*Metrics, error) {
	if cfg.Store == nil || cfg.Relay == nil {
		return nil, errors.New("metrics require a store and a relay stats source")
	}
	if err := ValidateMetricsToken(cfg.Token); err != nil {
		return nil, err
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.StartedAt.IsZero() {
		cfg.StartedAt = cfg.Clock()
	}
	ttl := cfg.TotalsCacheTTL
	if ttl <= 0 {
		ttl = defaultTotalsCacheTTL
	}
	return &Metrics{
		cfg:         cfg,
		tokenDigest: sha256.Sum256([]byte(cfg.Token)),
		cacheTTL:    ttl,
	}, nil
}

func (m *Metrics) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /metrics", m.handle)
}

// TokenRequired 报告当前是否处于令牌模式（否则为仅回环直连）。
func (m *Metrics) TokenRequired() bool {
	return m.cfg.Token != ""
}

func bearerToken(header string) (string, bool) {
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(header[len(prefix):]), true
}

// isDirectLoopback 只认 TCP 连接的远端地址，且要求请求不带任何代理转发头。
func isDirectLoopback(r *http.Request) bool {
	addrPort, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil || !addrPort.Addr().Unmap().IsLoopback() {
		return false
	}
	for _, name := range proxyHopHeaders {
		if len(r.Header.Values(name)) > 0 {
			return false
		}
	}
	return true
}

func (m *Metrics) handle(w http.ResponseWriter, r *http.Request) {
	if m.cfg.Token != "" {
		presented, ok := bearerToken(r.Header.Get("Authorization"))
		// 比较定长摘要：耗时与令牌内容、长度都无关。
		digest := sha256.Sum256([]byte(presented))
		if !ok || subtle.ConstantTimeCompare(digest[:], m.tokenDigest[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="quetzalcoatl-hub metrics"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	} else if !isDirectLoopback(r) {
		http.NotFound(w, r)
		return
	}

	body := m.render(r.Context())
	w.Header().Set("Content-Type", metricsContentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// totals 返回存储聚合；TTL 内复用上一次成功结果，并发抓取只触发一次查询。
// 失败不缓存，下一次抓取会重试。
func (m *Metrics) totals(ctx context.Context, now time.Time) (store.Totals, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cachePrimed {
		if age := now.Sub(m.cachedAt); age >= 0 && age < m.cacheTTL {
			return m.cached, true
		}
	}
	queryCtx, cancel := context.WithTimeout(ctx, totalsQueryTimeout)
	defer cancel()
	t, err := m.cfg.Store.Totals(queryCtx, now.UnixMilli())
	if err != nil {
		return store.Totals{}, false
	}
	m.cached, m.cachedAt, m.cachePrimed = t, now, true
	return t, true
}

type metricsWriter struct {
	b strings.Builder
}

func (w *metricsWriter) header(name, kind, help string) {
	w.b.WriteString("# HELP ")
	w.b.WriteString(name)
	w.b.WriteByte(' ')
	w.b.WriteString(help)
	w.b.WriteString("\n# TYPE ")
	w.b.WriteString(name)
	w.b.WriteByte(' ')
	w.b.WriteString(kind)
	w.b.WriteByte('\n')
}

func (w *metricsWriter) sample(name, labels, value string) {
	w.b.WriteString(name)
	w.b.WriteString(labels)
	w.b.WriteByte(' ')
	w.b.WriteString(value)
	w.b.WriteByte('\n')
}

func (w *metricsWriter) gaugeInt(name, help string, v int64) {
	w.header(name, "gauge", help)
	w.sample(name, "", strconv.FormatInt(v, 10))
}

func (w *metricsWriter) gaugeFloat(name, help string, v float64) {
	w.header(name, "gauge", help)
	w.sample(name, "", strconv.FormatFloat(v, 'f', -1, 64))
}

func (w *metricsWriter) counter(name, help string, v uint64) {
	w.header(name, "counter", help)
	w.sample(name, "", strconv.FormatUint(v, 10))
}

var labelValueEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)

func boolGauge(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func (m *Metrics) render(ctx context.Context) []byte {
	now := m.cfg.Clock()
	var w metricsWriter

	w.header("quetzalcoatl_hub_build_info", "gauge", "Build information; the value is always 1.")
	w.sample("quetzalcoatl_hub_build_info",
		`{version="`+labelValueEscaper.Replace(m.cfg.Version)+`",goversion="`+labelValueEscaper.Replace(runtime.Version())+`"}`,
		"1")
	w.gaugeFloat("quetzalcoatl_hub_start_time_seconds", "Unix time at which this process started.",
		float64(m.cfg.StartedAt.UnixMilli())/1000)
	w.gaugeFloat("quetzalcoatl_hub_uptime_seconds", "Seconds since this process started.",
		now.Sub(m.cfg.StartedAt).Seconds())

	totals, storeOK := m.totals(ctx, now)
	w.gaugeInt("quetzalcoatl_hub_store_up", "1 if the last database aggregate query succeeded, 0 otherwise. Store gauges below are omitted while it is 0.", boolGauge(storeOK))
	if storeOK {
		w.gaugeInt("quetzalcoatl_hub_accounts", "Registered accounts.", totals.Accounts)
		w.gaugeInt("quetzalcoatl_hub_agents", "Registered agents.", totals.Agents)
		w.gaugeInt("quetzalcoatl_hub_agents_near_quota", "Agents using at least 90% of their own storage quota.", totals.AgentsNearQuota)
		w.gaugeInt("quetzalcoatl_hub_spine_packs", "Encrypted spine packs stored.", totals.SpinePacks)
		w.gaugeFloat("quetzalcoatl_hub_spine_stored_bytes", "Bytes of encrypted spine packs stored, summed over all agents.", totals.StoredBytes)
		w.gaugeFloat("quetzalcoatl_hub_spine_quota_bytes", "Storage quota granted, summed over all agents.", totals.QuotaBytes)
		w.gaugeInt("quetzalcoatl_hub_leases_active", "Agents that currently hold an unexpired lease.", totals.ActiveLeases)
		w.gaugeInt("quetzalcoatl_hub_webhook_ingress_queue_depth", "Sealed webhook rows waiting to be fetched, summed over all agents.", totals.WebhookIngressRows)
	}
	w.gaugeInt("quetzalcoatl_hub_agent_default_quota_bytes", "Storage quota given to each newly created agent.", m.cfg.DefaultAgentQuotaBytes)

	rs := m.cfg.Relay()
	w.gaugeInt("quetzalcoatl_hub_relay_connections", "Relay connections currently authenticated and open.", rs.Connections)
	w.counter("quetzalcoatl_hub_relay_connections_accepted_total", "Relay connections that completed authentication since start.", rs.ConnectionsAccepted)
	w.counter("quetzalcoatl_hub_relay_forwarded_frames_total", "Datagram frames queued for delivery to a destination connection since start.", rs.ForwardedFrames)
	w.counter("quetzalcoatl_hub_relay_forwarded_bytes_total", "Datagram payload bytes queued for delivery to a destination connection since start.", rs.ForwardedBytes)
	w.counter("quetzalcoatl_hub_relay_dropped_frames_total", "Datagram frames dropped because the destination send queue was full since start.", rs.DroppedFrames)

	w.gaugeInt("quetzalcoatl_hub_qad_enabled", "1 if the UDP address discovery listener is running, 0 if disabled.", boolGauge(m.cfg.QAD != nil))
	if m.cfg.QAD != nil {
		qs := m.cfg.QAD()
		w.counter("quetzalcoatl_hub_qad_requests_total", "Address discovery sessions opened since start.", qs.Requests)
		w.counter("quetzalcoatl_hub_qad_reports_total", "Address discovery sessions answered with the observed address since start.", qs.Reports)
	}

	return []byte(w.b.String())
}

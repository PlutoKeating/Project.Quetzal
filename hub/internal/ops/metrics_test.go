// SPDX-License-Identifier: AGPL-3.0-only

package ops_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"quetzalcoatl-hub/internal/ops"
	"quetzalcoatl-hub/internal/relay"
	"quetzalcoatl-hub/internal/store"
)

const testMetricsToken = "test-metrics-token-0123456789"

type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time { return c.now }

type stubTotals struct {
	calls  atomic.Int64
	totals store.Totals
	err    error
}

func (s *stubTotals) Totals(context.Context, int64) (store.Totals, error) {
	s.calls.Add(1)
	return s.totals, s.err
}

func fixedRelayStats() relay.Stats {
	return relay.Stats{Connections: 3, ConnectionsAccepted: 11, ForwardedFrames: 40, ForwardedBytes: 4096, DroppedFrames: 2}
}

func fixedQADStats() relay.QADStats {
	return relay.QADStats{Requests: 9, Reports: 7}
}

func newTestMetrics(t *testing.T, cfg ops.MetricsConfig) http.Handler {
	t.Helper()
	if cfg.Version == "" {
		cfg.Version = "9.9.9-test"
	}
	if cfg.Store == nil {
		cfg.Store = &stubTotals{}
	}
	if cfg.Relay == nil {
		cfg.Relay = fixedRelayStats
	}
	metrics, err := ops.NewMetrics(cfg)
	if err != nil {
		t.Fatalf("NewMetrics: %v", err)
	}
	mux := http.NewServeMux()
	metrics.RegisterRoutes(mux)
	return mux
}

func scrape(t *testing.T, h http.Handler, remoteAddr string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.RemoteAddr = remoteAddr
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// parseSamples 校验 Prometheus 文本格式的基本结构并返回 `名字{标签}` → 值。
func parseSamples(t *testing.T, body string) map[string]string {
	t.Helper()
	sampleRe := regexp.MustCompile(`^([a-z_][a-z0-9_]*)(\{[^}]*\})? (-?[0-9.]+)$`)
	samples := make(map[string]string)
	helped := make(map[string]bool)
	typed := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSuffix(body, "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "# HELP "):
			name, _, _ := strings.Cut(strings.TrimPrefix(line, "# HELP "), " ")
			helped[name] = true
		case strings.HasPrefix(line, "# TYPE "):
			name, kind, _ := strings.Cut(strings.TrimPrefix(line, "# TYPE "), " ")
			if kind != "gauge" && kind != "counter" {
				t.Fatalf("unexpected metric type in %q", line)
			}
			typed[name] = kind
		default:
			m := sampleRe.FindStringSubmatch(line)
			if m == nil {
				t.Fatalf("line is not a valid sample: %q", line)
			}
			name := m[1]
			if !strings.HasPrefix(name, "quetzalcoatl_hub_") {
				t.Fatalf("metric %q lacks the quetzalcoatl_hub_ prefix", name)
			}
			if !helped[name] || typed[name] == "" {
				t.Fatalf("sample %q is not preceded by HELP and TYPE", name)
			}
			if (typed[name] == "counter") != strings.HasSuffix(name, "_total") {
				t.Fatalf("metric %q: counters and only counters end in _total (type %s)", name, typed[name])
			}
			if m[2] != "" && name != "quetzalcoatl_hub_build_info" {
				t.Fatalf("only build_info may carry labels, got %q", line)
			}
			samples[name+m[2]] = m[3]
		}
	}
	return samples
}

func TestMetricsLoopbackOnlyWhenNoTokenConfigured(t *testing.T) {
	h := newTestMetrics(t, ops.MetricsConfig{})

	cases := []struct {
		name       string
		remoteAddr string
		headers    map[string]string
		want       int
	}{
		{"ipv4 loopback", "127.0.0.1:50000", nil, http.StatusOK},
		{"ipv4 loopback other host", "127.8.9.10:50000", nil, http.StatusOK},
		{"ipv6 loopback", "[::1]:50000", nil, http.StatusOK},
		{"ipv4-mapped loopback", "[::ffff:127.0.0.1]:50000", nil, http.StatusOK},
		{"loopback ignores a stray authorization header", "127.0.0.1:50000", map[string]string{"Authorization": "Bearer whatever"}, http.StatusOK},
		{"public ipv4", "203.0.113.9:50000", nil, http.StatusNotFound},
		{"private lan", "192.168.1.20:50000", nil, http.StatusNotFound},
		{"container bridge gateway", "172.17.0.1:50000", nil, http.StatusNotFound},
		{"public ipv6", "[2001:db8::1]:50000", nil, http.StatusNotFound},
		{"unparseable remote", "not-an-address", nil, http.StatusNotFound},
		{"forwarded header cannot claim loopback", "203.0.113.9:50000", map[string]string{"X-Forwarded-For": "127.0.0.1"}, http.StatusNotFound},
		{"real-ip header cannot claim loopback", "203.0.113.9:50000", map[string]string{"X-Real-IP": "127.0.0.1"}, http.StatusNotFound},
		{"same-host proxy: x-forwarded-for", "127.0.0.1:50000", map[string]string{"X-Forwarded-For": "203.0.113.9"}, http.StatusNotFound},
		{"same-host proxy: forwarded", "127.0.0.1:50000", map[string]string{"Forwarded": "for=203.0.113.9"}, http.StatusNotFound},
		{"same-host tunnel: cf-connecting-ip", "[::1]:50000", map[string]string{"CF-Connecting-IP": "203.0.113.9"}, http.StatusNotFound},
		{"same-host proxy: via", "127.0.0.1:50000", map[string]string{"Via": "1.1 proxy"}, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := scrape(t, h, tc.remoteAddr, tc.headers)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusNotFound && strings.Contains(rec.Body.String(), "quetzalcoatl_hub_") {
				t.Fatalf("rejected request leaked metrics: %q", rec.Body.String())
			}
		})
	}

	// 被拒绝的请求必须与「没有这个路由」长得一样。
	bare := httptest.NewRecorder()
	http.NewServeMux().ServeHTTP(bare, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	rejected := scrape(t, h, "203.0.113.9:50000", nil)
	if rejected.Code != bare.Code || rejected.Body.String() != bare.Body.String() {
		t.Fatalf("rejection differs from an unrouted 404: %d %q vs %d %q", rejected.Code, rejected.Body.String(), bare.Code, bare.Body.String())
	}
}

func TestMetricsBearerTokenWhenConfigured(t *testing.T) {
	h := newTestMetrics(t, ops.MetricsConfig{Token: testMetricsToken})

	cases := []struct {
		name       string
		remoteAddr string
		auth       string
		want       int
	}{
		{"correct token from a remote scraper", "203.0.113.9:50000", "Bearer " + testMetricsToken, http.StatusOK},
		{"scheme is case-insensitive", "203.0.113.9:50000", "bearer " + testMetricsToken, http.StatusOK},
		{"correct token from loopback", "127.0.0.1:50000", "Bearer " + testMetricsToken, http.StatusOK},
		{"missing header", "203.0.113.9:50000", "", http.StatusUnauthorized},
		{"loopback gets no free pass once a token is set", "127.0.0.1:50000", "", http.StatusUnauthorized},
		{"wrong token", "203.0.113.9:50000", "Bearer wrong-metrics-token-0123456789", http.StatusUnauthorized},
		{"prefix of the token", "203.0.113.9:50000", "Bearer " + testMetricsToken[:len(testMetricsToken)-1], http.StatusUnauthorized},
		{"token with a suffix", "203.0.113.9:50000", "Bearer " + testMetricsToken + "x", http.StatusUnauthorized},
		{"empty bearer", "203.0.113.9:50000", "Bearer ", http.StatusUnauthorized},
		{"basic auth", "203.0.113.9:50000", "Basic " + testMetricsToken, http.StatusUnauthorized},
		{"bare token without scheme", "203.0.113.9:50000", testMetricsToken, http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var headers map[string]string
			if tc.auth != "" {
				headers = map[string]string{"Authorization": tc.auth}
			}
			rec := scrape(t, h, tc.remoteAddr, headers)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
			if tc.want != http.StatusOK {
				if strings.Contains(rec.Body.String(), "quetzalcoatl_hub_") {
					t.Fatalf("rejected request leaked metrics: %q", rec.Body.String())
				}
				if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
					t.Fatalf("401 must carry a Bearer challenge, got %q", rec.Header().Get("WWW-Authenticate"))
				}
			}
		})
	}
}

func TestMetricsTokenShapeIsValidatedAtStartup(t *testing.T) {
	for _, token := range []string{"1", "true", "short-token", "has space in the token value", "tab\tinside-the-token-value", strings.Repeat("x", 257)} {
		if _, err := ops.NewMetrics(ops.MetricsConfig{Token: token, Store: &stubTotals{}, Relay: fixedRelayStats}); err == nil {
			t.Fatalf("token %q must be rejected", token)
		}
	}
	if _, err := ops.NewMetrics(ops.MetricsConfig{Token: strings.Repeat("x", ops.MetricsTokenMinLen), Store: &stubTotals{}, Relay: fixedRelayStats}); err != nil {
		t.Fatalf("minimum-length token rejected: %v", err)
	}
}

// 用真实的 TCP 连接确认「回环直连」判断的是连接远端，而不是测试里手填的字段。
func TestMetricsOverRealLoopbackConnection(t *testing.T) {
	srv := httptest.NewServer(newTestMetrics(t, ops.MetricsConfig{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body %q", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/plain; version=0.0.4; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	parseSamples(t, string(body))

	post, err := http.Post(srv.URL+"/metrics", "text/plain", nil)
	if err != nil {
		t.Fatalf("POST /metrics: %v", err)
	}
	_ = post.Body.Close()
	if post.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", post.StatusCode)
	}
}

func TestMetricsExposeEveryPromisedSeries(t *testing.T) {
	clock := &fakeClock{now: time.UnixMilli(1_800_000_090_500)}
	h := newTestMetrics(t, ops.MetricsConfig{
		Version:                `2.0.0-"quoted"\path`,
		StartedAt:              time.UnixMilli(1_800_000_000_000),
		DefaultAgentQuotaBytes: 1 << 30,
		Store: &stubTotals{totals: store.Totals{
			Accounts: 5, Agents: 8, AgentsNearQuota: 1, SpinePacks: 120,
			StoredBytes: 123456789, QuotaBytes: 8 * (1 << 30), ActiveLeases: 4, WebhookIngressRows: 17,
		}},
		QAD:   fixedQADStats,
		Clock: clock.Now,
	})
	rec := scrape(t, h, "127.0.0.1:50000", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	samples := parseSamples(t, rec.Body.String())

	if !strings.Contains(rec.Body.String(), `quetzalcoatl_hub_build_info{version="2.0.0-\"quoted\"\\path",goversion="go`) {
		t.Fatalf("build_info label is missing or not escaped:\n%s", rec.Body.String())
	}
	want := map[string]string{
		"quetzalcoatl_hub_start_time_seconds":               "1800000000",
		"quetzalcoatl_hub_uptime_seconds":                   "90.5",
		"quetzalcoatl_hub_store_up":                         "1",
		"quetzalcoatl_hub_accounts":                         "5",
		"quetzalcoatl_hub_agents":                           "8",
		"quetzalcoatl_hub_agents_near_quota":                "1",
		"quetzalcoatl_hub_spine_packs":                      "120",
		"quetzalcoatl_hub_spine_stored_bytes":               "123456789",
		"quetzalcoatl_hub_spine_quota_bytes":                "8589934592",
		"quetzalcoatl_hub_agent_default_quota_bytes":        "1073741824",
		"quetzalcoatl_hub_leases_active":                    "4",
		"quetzalcoatl_hub_webhook_ingress_queue_depth":      "17",
		"quetzalcoatl_hub_relay_connections":                "3",
		"quetzalcoatl_hub_relay_connections_accepted_total": "11",
		"quetzalcoatl_hub_relay_forwarded_frames_total":     "40",
		"quetzalcoatl_hub_relay_forwarded_bytes_total":      "4096",
		"quetzalcoatl_hub_relay_dropped_frames_total":       "2",
		"quetzalcoatl_hub_qad_enabled":                      "1",
		"quetzalcoatl_hub_qad_requests_total":               "9",
		"quetzalcoatl_hub_qad_reports_total":                "7",
	}
	for name, value := range want {
		if got, ok := samples[name]; !ok || got != value {
			t.Errorf("%s = %q (present=%v), want %q", name, got, ok, value)
		}
	}
	// 清单之外不得多出序列：新增指标必须同步更新这里与部署文档。
	if len(samples) != len(want)+1 {
		t.Errorf("exposed %d series, want %d plus build_info:\n%s", len(samples), len(want), rec.Body.String())
	}
}

func TestMetricsOmitQADCountersWhenDiscoveryIsDisabled(t *testing.T) {
	rec := scrape(t, newTestMetrics(t, ops.MetricsConfig{}), "127.0.0.1:50000", nil)
	samples := parseSamples(t, rec.Body.String())
	if samples["quetzalcoatl_hub_qad_enabled"] != "0" {
		t.Fatalf("qad_enabled = %q, want 0", samples["quetzalcoatl_hub_qad_enabled"])
	}
	for name := range samples {
		if strings.HasPrefix(name, "quetzalcoatl_hub_qad_") && name != "quetzalcoatl_hub_qad_enabled" {
			t.Fatalf("disabled discovery must not expose %s", name)
		}
	}
}

func TestMetricsStayUpWhenTheStoreFails(t *testing.T) {
	failing := &stubTotals{err: errors.New("database is unavailable: secret-dsn-detail")}
	h := newTestMetrics(t, ops.MetricsConfig{Store: failing})

	rec := scrape(t, h, "127.0.0.1:50000", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("a failing store must not take /metrics down, status = %d", rec.Code)
	}
	samples := parseSamples(t, rec.Body.String())
	if samples["quetzalcoatl_hub_store_up"] != "0" {
		t.Fatalf("store_up = %q, want 0", samples["quetzalcoatl_hub_store_up"])
	}
	for _, name := range []string{"quetzalcoatl_hub_accounts", "quetzalcoatl_hub_agents", "quetzalcoatl_hub_spine_packs", "quetzalcoatl_hub_leases_active"} {
		if _, ok := samples[name]; ok {
			t.Fatalf("%s must be omitted rather than reported as 0 while the store is down", name)
		}
	}
	if samples["quetzalcoatl_hub_relay_connections"] != "3" {
		t.Fatalf("relay series must survive a store failure")
	}
	if strings.Contains(rec.Body.String(), "secret-dsn-detail") {
		t.Fatalf("store error text leaked into metrics")
	}

	// 失败不缓存：存储恢复后下一次抓取立刻恢复。
	failing.err = nil
	failing.totals = store.Totals{Accounts: 2}
	samples = parseSamples(t, scrape(t, h, "127.0.0.1:50000", nil).Body.String())
	if samples["quetzalcoatl_hub_store_up"] != "1" || samples["quetzalcoatl_hub_accounts"] != "2" {
		t.Fatalf("store did not recover on the next scrape: %v", samples)
	}
}

func TestMetricsReuseStoreTotalsWithinTheCacheWindow(t *testing.T) {
	clock := &fakeClock{now: time.UnixMilli(1_800_000_000_000)}
	source := &stubTotals{totals: store.Totals{Accounts: 1}}
	h := newTestMetrics(t, ops.MetricsConfig{Store: source, Clock: clock.Now, TotalsCacheTTL: 5 * time.Second})

	for i := 0; i < 20; i++ {
		scrape(t, h, "127.0.0.1:50000", nil)
	}
	if got := source.calls.Load(); got != 1 {
		t.Fatalf("20 scrapes inside the window hit the store %d times, want 1", got)
	}

	source.totals = store.Totals{Accounts: 2}
	clock.now = clock.now.Add(4999 * time.Millisecond)
	if samples := parseSamples(t, scrape(t, h, "127.0.0.1:50000", nil).Body.String()); samples["quetzalcoatl_hub_accounts"] != "1" {
		t.Fatalf("cache expired early: %v", samples["quetzalcoatl_hub_accounts"])
	}
	clock.now = clock.now.Add(time.Millisecond)
	if samples := parseSamples(t, scrape(t, h, "127.0.0.1:50000", nil).Body.String()); samples["quetzalcoatl_hub_accounts"] != "2" {
		t.Fatalf("cache did not expire at the TTL: %v", samples["quetzalcoatl_hub_accounts"])
	}
	if got := source.calls.Load(); got != 2 {
		t.Fatalf("store hit %d times, want 2", got)
	}
}

// 端到端：真实 SQLite 里放入带标记的账户、Agent、设备，指标里只能出现总量。
func TestMetricsNeverExposeIdentifiers(t *testing.T) {
	st, err := store.NewSQLiteStore(filepath.Join(t.TempDir(), "hub.sqlite"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()

	canaries := []string{"canary-account", "canary-agent", "canary-device", "canary-pack", "canary-blob", "canary-event", "canary-subject", "canary-issuer"}
	if err := st.CreateAccount(ctx, store.Account{AccountID: "canary-account", OIDCIssuer: "https://canary-issuer.example", OIDCSubject: "canary-subject", CreatedAtMs: 1}); err != nil {
		t.Fatalf("account: %v", err)
	}
	if err := st.CreateAgent(ctx, store.Agent{AgentID: "canary-agent", OwnerAccountID: "canary-account", RootVerifyingKeyHex: "00", QuotaBytes: 1000, CreatedAtMs: 1}); err != nil {
		t.Fatalf("agent: %v", err)
	}
	if err := st.UpsertDevice(ctx, store.Device{AgentID: "canary-agent", DeviceID: "canary-device", AccountID: "canary-account", Ed25519PubKeyHex: "00", XWingPubKeyHex: "00", CreatedAtMs: 1}); err != nil {
		t.Fatalf("device: %v", err)
	}
	sha := fmt.Sprintf("%064x", 950)
	if err := st.CreatePackUpload(ctx, store.PackUpload{UploadID: "upload", AgentID: "canary-agent", PackID: "canary-pack", ContentLength: 950, SHA256Hex: sha, BlobKey: "canary-blob", ExpiresAtMs: math.MaxInt64}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if err := st.MarkPackUploaded(ctx, "upload"); err != nil {
		t.Fatalf("mark uploaded: %v", err)
	}
	if _, err := st.CommitSpinePack(ctx, "upload", store.SpinePackRecord{AgentID: "canary-agent", PackID: "canary-pack", DeviceID: "canary-device", ContentLength: 950, SHA256Hex: sha, AADUTF8: "{}"}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	if _, err := st.AcquireLease(ctx, "canary-agent", "canary-device", 0, 60_000, now.UnixMilli()); err != nil {
		t.Fatalf("lease: %v", err)
	}
	if _, err := st.EnqueueWebhookIngressBatch(ctx, "canary-agent", "webhook", "canary-event", []store.WebhookIngressRow{
		{TargetDeviceID: "canary-device", HPKEEncHex: "aa", CiphertextHex: "bb", AADUTF8: "{}", ReceivedAtMs: 1, CreatedAtMs: 1},
	}, 16); err != nil {
		t.Fatalf("webhook: %v", err)
	}

	clock := &fakeClock{now: now}
	h := newTestMetrics(t, ops.MetricsConfig{Store: st, Clock: clock.Now, DefaultAgentQuotaBytes: 1000})
	body := scrape(t, h, "127.0.0.1:50000", nil).Body.String()
	samples := parseSamples(t, body)

	for name, value := range map[string]string{
		"quetzalcoatl_hub_store_up":                    "1",
		"quetzalcoatl_hub_accounts":                    "1",
		"quetzalcoatl_hub_agents":                      "1",
		"quetzalcoatl_hub_agents_near_quota":           "1",
		"quetzalcoatl_hub_spine_packs":                 "1",
		"quetzalcoatl_hub_spine_stored_bytes":          "950",
		"quetzalcoatl_hub_spine_quota_bytes":           "1000",
		"quetzalcoatl_hub_leases_active":               "1",
		"quetzalcoatl_hub_webhook_ingress_queue_depth": "1",
	} {
		if samples[name] != value {
			t.Errorf("%s = %q, want %q", name, samples[name], value)
		}
	}
	for _, canary := range canaries {
		if strings.Contains(body, canary) {
			t.Errorf("metrics leaked identifier %q:\n%s", canary, body)
		}
	}
}

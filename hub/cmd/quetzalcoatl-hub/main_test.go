// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const (
	envRunMain  = "QUETZALCOATL_HUB_TEST_RUN_MAIN"
	envMainArgs = "QUETZALCOATL_HUB_TEST_MAIN_ARGS"

	testMetricsToken = "test-metrics-token-0123456789"
)

// TestMain 让测试二进制在子进程里充当真正的 quetzalcoatl-hub：
// 这样环境变量名、路由挂载与启动校验都按真实进程的路径被验证。
func TestMain(m *testing.M) {
	if os.Getenv(envRunMain) == "1" {
		os.Args = append([]string{"quetzalcoatl-hub"}, strings.Fields(os.Getenv(envMainArgs))...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

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

func freeLoopbackAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// hubCommand 以干净的环境运行子进程，不继承外面的任何 QUETZALCOATL_* 变量。
func hubCommand(t *testing.T, args string, env ...string) (*exec.Cmd, *lockedBuffer) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append([]string{
		envRunMain + "=1",
		envMainArgs + "=" + args,
		"QUETZALCOATL_HUB_DATA_DIR=" + t.TempDir(),
		"QUETZALCOATL_HUB_QAD_ADDR=127.0.0.1:0",
	}, env...)
	logs := &lockedBuffer{}
	cmd.Stdout = logs
	cmd.Stderr = logs
	return cmd, logs
}

type runningHub struct {
	addr    string
	baseURL string
	cmd     *exec.Cmd
	logs    *lockedBuffer
	exited  chan error
}

func startHub(t *testing.T, env ...string) *runningHub {
	t.Helper()
	addr := freeLoopbackAddr(t)
	cmd, logs := hubCommand(t, "", append([]string{"QUETZALCOATL_HUB_ADDR=" + addr}, env...)...)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start hub: %v", err)
	}
	hub := &runningHub{addr: addr, baseURL: "http://" + addr, cmd: cmd, logs: logs, exited: make(chan error, 1)}
	go func() { hub.exited <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		select {
		case <-hub.exited:
		case <-time.After(5 * time.Second):
		}
	})

	deadline := time.Now().Add(20 * time.Second)
	for {
		resp, err := http.Get(hub.baseURL + "/healthz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return hub
			}
		}
		select {
		case exitErr := <-hub.exited:
			hub.exited <- exitErr
			t.Fatalf("hub exited before becoming ready (%v):\n%s", exitErr, logs.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("hub did not become ready:\n%s", logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (h *runningHub) get(t *testing.T, path string, headers map[string]string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.baseURL+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v\n%s", path, err, h.logs.String())
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return resp.StatusCode, resp.Header, string(body)
}

func decodeMeta(t *testing.T, body string) map[string]any {
	t.Helper()
	var meta map[string]any
	if err := json.Unmarshal([]byte(body), &meta); err != nil {
		t.Fatalf("/v1/meta is not JSON: %v (%q)", err, body)
	}
	return meta
}

func exitCode(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	if err != nil {
		return -1
	}
	return 0
}

func TestHubServesMetricsAndMetaWithDefaults(t *testing.T) {
	hub := startHub(t)

	status, header, body := hub.get(t, "/metrics", nil)
	if status != http.StatusOK {
		t.Fatalf("/metrics from loopback without a token: status %d\n%s", status, body)
	}
	if got := header.Get("Content-Type"); got != "text/plain; version=0.0.4; charset=utf-8" {
		t.Fatalf("/metrics Content-Type = %q", got)
	}
	for _, want := range []string{
		"quetzalcoatl_hub_build_info{version=\"",
		"\nquetzalcoatl_hub_store_up 1\n",
		"\nquetzalcoatl_hub_accounts 0\n",
		"\nquetzalcoatl_hub_agents 0\n",
		"\nquetzalcoatl_hub_spine_packs 0\n",
		"\nquetzalcoatl_hub_agent_default_quota_bytes 1073741824\n",
		"\nquetzalcoatl_hub_relay_connections 0\n",
		"\nquetzalcoatl_hub_qad_enabled 1\n",
		"\nquetzalcoatl_hub_qad_requests_total 0\n",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics is missing %q:\n%s", want, body)
		}
	}
	if status, _, body := hub.get(t, "/metrics", map[string]string{"X-Forwarded-For": "203.0.113.9"}); status != http.StatusNotFound {
		t.Fatalf("proxied request without a token must get 404, got %d\n%s", status, body)
	}

	status, header, body = hub.get(t, "/v1/meta", nil)
	if status != http.StatusOK {
		t.Fatalf("/v1/meta status %d", status)
	}
	meta := decodeMeta(t, body)
	if meta["min_client_version"] != "" || meta["announcement"] != "" {
		t.Fatalf("defaults must be empty strings: %v", meta)
	}
	if v, _ := meta["server_version"].(string); v == "" {
		t.Fatalf("server_version must not be empty: %v", meta)
	}
	serverMs, _ := meta["server_time_ms"].(float64)
	if skew := time.Since(time.UnixMilli(int64(serverMs))); skew < -time.Minute || skew > time.Minute {
		t.Fatalf("server_time_ms is %v away from now", skew)
	}
	if got := header.Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("/v1/meta Cache-Control = %q", got)
	}

	// 模型代理已删除：它的前缀不再有任何路由。
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		req, _ := http.NewRequest(method, hub.baseURL+"/v1/llm/v1/chat/completions", strings.NewReader(`{}`))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s /v1/llm: %v", method, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s /v1/llm/... status = %d, want 404", method, resp.StatusCode)
		}
	}

	// 自检子命令读同一个监听地址。
	check, checkLogs := hubCommand(t, "healthcheck", "QUETZALCOATL_HUB_ADDR="+hub.addr)
	if err := check.Run(); err != nil {
		t.Fatalf("healthcheck against a live hub failed: %v\n%s", err, checkLogs.String())
	}

	if err := hub.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal hub: %v", err)
	}
	select {
	case err := <-hub.exited:
		hub.exited <- err
		if err != nil {
			t.Fatalf("hub must exit cleanly on SIGTERM, got %v\n%s", err, hub.logs.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("hub did not exit on SIGTERM:\n%s", hub.logs.String())
	}

	down, downLogs := hubCommand(t, "healthcheck", "QUETZALCOATL_HUB_ADDR="+hub.addr)
	if code := exitCode(down.Run()); code != 1 {
		t.Fatalf("healthcheck against a stopped hub: exit code %d, want 1\n%s", code, downLogs.String())
	}
}

func TestHubReadsMetricsTokenAndMetaFromEnvironment(t *testing.T) {
	hub := startHub(t,
		"QUETZALCOATL_HUB_METRICS_TOKEN="+testMetricsToken,
		"QUETZALCOATL_HUB_MIN_CLIENT_VERSION=2.0.0-alpha.4",
		"QUETZALCOATL_HUB_ANNOUNCEMENT=周六凌晨维护，同步会暂停一小时",
		"QUETZALCOATL_HUB_AGENT_QUOTA_BYTES=2048",
		"QUETZALCOATL_HUB_QAD_ADDR=off",
	)

	if status, _, body := hub.get(t, "/metrics", nil); status != http.StatusUnauthorized || strings.Contains(body, "quetzalcoatl_hub_") {
		t.Fatalf("loopback without the token must get 401 once a token is set, got %d\n%s", status, body)
	}
	if status, _, _ := hub.get(t, "/metrics", map[string]string{"Authorization": "Bearer wrong-metrics-token-0123456789"}); status != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d, want 401", status)
	}
	status, _, body := hub.get(t, "/metrics", map[string]string{"Authorization": "Bearer " + testMetricsToken})
	if status != http.StatusOK {
		t.Fatalf("correct token: status %d\n%s", status, body)
	}
	for _, want := range []string{
		"\nquetzalcoatl_hub_agent_default_quota_bytes 2048\n",
		"\nquetzalcoatl_hub_qad_enabled 0\n",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics is missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "quetzalcoatl_hub_qad_requests_total") {
		t.Errorf("disabled address discovery must not expose its counters")
	}
	if strings.Contains(body, testMetricsToken) || strings.Contains(hub.logs.String(), testMetricsToken) {
		t.Fatalf("the metrics token leaked into output or logs")
	}

	_, _, body = hub.get(t, "/v1/meta", nil)
	meta := decodeMeta(t, body)
	if meta["min_client_version"] != "2.0.0-alpha.4" || meta["announcement"] != "周六凌晨维护，同步会暂停一小时" {
		t.Fatalf("/v1/meta did not pick up the environment: %v", meta)
	}
}

func TestHubRefusesToStartWithInvalidOpsConfig(t *testing.T) {
	cases := []struct {
		name    string
		env     string
		mention string
	}{
		{"announcement over 500 bytes", "QUETZALCOATL_HUB_ANNOUNCEMENT=" + strings.Repeat("a", 501), "QUETZALCOATL_HUB_ANNOUNCEMENT"},
		{"min client version with v prefix", "QUETZALCOATL_HUB_MIN_CLIENT_VERSION=v2.0.0", "QUETZALCOATL_HUB_MIN_CLIENT_VERSION"},
		{"metrics token used as a switch", "QUETZALCOATL_HUB_METRICS_TOKEN=true", "QUETZALCOATL_HUB_METRICS_TOKEN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd, logs := hubCommand(t, "", "QUETZALCOATL_HUB_ADDR="+freeLoopbackAddr(t), tc.env)
			done := make(chan error, 1)
			if err := cmd.Start(); err != nil {
				t.Fatalf("start: %v", err)
			}
			go func() { done <- cmd.Wait() }()
			select {
			case err := <-done:
				if code := exitCode(err); code != 1 {
					t.Fatalf("exit code %d, want 1\n%s", code, logs.String())
				}
			case <-time.After(20 * time.Second):
				_ = cmd.Process.Kill()
				t.Fatalf("hub kept running with invalid configuration:\n%s", logs.String())
			}
			if !strings.Contains(logs.String(), tc.mention) {
				t.Fatalf("startup error must name %s:\n%s", tc.mention, logs.String())
			}
		})
	}
}

func TestHubCommandLine(t *testing.T) {
	versionCmd, versionOut := hubCommand(t, "version")
	if err := versionCmd.Run(); err != nil || strings.TrimSpace(versionOut.String()) == "" {
		t.Fatalf("version: err=%v output=%q", err, versionOut.String())
	}
	unknown, unknownOut := hubCommand(t, "serve")
	if code := exitCode(unknown.Run()); code != 2 || !strings.Contains(unknownOut.String(), "unknown command") {
		t.Fatalf("unknown command: exit code %d output=%q", code, unknownOut.String())
	}
}

func TestBuildVersionPrefersTheInjectedVersion(t *testing.T) {
	previous := version
	t.Cleanup(func() { version = previous })

	version = " 2.0.0-alpha.4 "
	if got := buildVersion(); got != "2.0.0-alpha.4" {
		t.Fatalf("buildVersion() = %q", got)
	}
	version = ""
	if got := buildVersion(); got != "dev" && !strings.HasPrefix(got, "dev+") {
		t.Fatalf("uninjected build must report a dev version, got %q", got)
	}
}

func TestHealthcheckURL(t *testing.T) {
	cases := []struct {
		cfg  listenConfig
		want string
	}{
		{listenConfig{addr: "127.0.0.1:8443"}, "http://127.0.0.1:8443/healthz"},
		{listenConfig{addr: "0.0.0.0:8443"}, "http://127.0.0.1:8443/healthz"},
		{listenConfig{addr: ":8443"}, "http://127.0.0.1:8443/healthz"},
		{listenConfig{addr: "[::]:8443"}, "http://127.0.0.1:8443/healthz"},
		{listenConfig{addr: "[::1]:9000", enableHTTPS: true}, "https://[::1]:9000/healthz"},
		{listenConfig{addr: "10.0.0.5:443", enableHTTPS: true}, "https://10.0.0.5:443/healthz"},
	}
	for _, tc := range cases {
		got, err := healthcheckURL(tc.cfg)
		if err != nil || got != tc.want {
			t.Errorf("healthcheckURL(%+v) = %q, %v; want %q", tc.cfg, got, err, tc.want)
		}
	}
	if _, err := healthcheckURL(listenConfig{addr: "no-port"}); err == nil {
		t.Errorf("an address without a port must be rejected")
	}
}

func TestRunHealthcheckFollowsTheListenConfiguration(t *testing.T) {
	healthz := func(status int) http.Handler {
		mux := http.NewServeMux()
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
		return mux
	}
	for _, key := range []string{"QUETZALCOATL_HUB_TLS", "QUETZALCOATL_HUB_TLS_CERT_FILE", "QUETZALCOATL_HUB_TLS_KEY_FILE"} {
		t.Setenv(key, "")
	}

	plain := httptest.NewServer(healthz(http.StatusOK))
	defer plain.Close()
	t.Setenv("QUETZALCOATL_HUB_ADDR", plain.Listener.Addr().String())
	if err := runHealthcheck(); err != nil {
		t.Fatalf("plain HTTP healthcheck: %v", err)
	}

	unhealthy := httptest.NewServer(healthz(http.StatusServiceUnavailable))
	defer unhealthy.Close()
	t.Setenv("QUETZALCOATL_HUB_ADDR", unhealthy.Listener.Addr().String())
	if err := runHealthcheck(); err == nil {
		t.Fatalf("a non-200 /healthz must fail the healthcheck")
	}

	// 自带证书直出：证书不是签给回环地址的，自检仍须通过。
	secure := httptest.NewTLSServer(healthz(http.StatusOK))
	defer secure.Close()
	t.Setenv("QUETZALCOATL_HUB_ADDR", secure.Listener.Addr().String())
	if err := runHealthcheck(); err == nil {
		t.Fatalf("speaking plain HTTP to a TLS listener must fail")
	}
	t.Setenv("QUETZALCOATL_HUB_TLS", "1")
	if err := runHealthcheck(); err != nil {
		t.Fatalf("TLS healthcheck: %v", err)
	}

	t.Setenv("QUETZALCOATL_HUB_ADDR", fmt.Sprintf("127.0.0.1:%d", 1))
	if err := runHealthcheck(); err == nil {
		t.Fatalf("nothing listening must fail the healthcheck")
	}
}

// 部署模板承诺列出 main.go 读取的全部环境变量：多一个、少一个都算漂移。
func TestEnvTemplateDocumentsExactlyTheVariablesMainReads(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	template, err := os.ReadFile(filepath.Join("..", "..", "deploy", "hub.env.example"))
	if err != nil {
		t.Fatalf("read hub.env.example: %v", err)
	}

	read := make(map[string]bool)
	for _, m := range regexp.MustCompile(`"(QUETZALCOATL_[A-Z0-9_]+)"`).FindAllSubmatch(source, -1) {
		read[string(m[1])] = true
	}
	// 各通道的验签密钥变量名是拼出来的，源码里只有前缀。
	const channelSecretPrefix = "QUETZALCOATL_HUB_WEBHOOK_SECRET_"
	if !read[channelSecretPrefix] {
		t.Fatalf("main.go no longer builds %s<CHANNEL>; update this test", channelSecretPrefix)
	}
	delete(read, channelSecretPrefix)
	for _, channel := range webhookSecretChannels {
		read[webhookSecretEnvKey(channel)] = true
	}

	documented := make(map[string]bool)
	for _, m := range regexp.MustCompile(`(?m)^#?(QUETZALCOATL_[A-Z0-9_]+)=`).FindAllSubmatch(template, -1) {
		documented[string(m[1])] = true
	}

	var missing, stale []string
	for name := range read {
		if !documented[name] {
			missing = append(missing, name)
		}
	}
	for name := range documented {
		if !read[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing) > 0 || len(stale) > 0 {
		t.Fatalf("hub.env.example is out of sync with main.go\n  read but undocumented: %v\n  documented but never read: %v", missing, stale)
	}
	if len(read) < 40 {
		t.Fatalf("only found %d variables in main.go; the extraction is probably broken", len(read))
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

package ops_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"quetzalcoatl-hub/internal/ops"
)

func newTestMeta(t *testing.T, cfg ops.MetaConfig) http.Handler {
	t.Helper()
	meta, err := ops.NewMeta(cfg)
	if err != nil {
		t.Fatalf("NewMeta: %v", err)
	}
	mux := http.NewServeMux()
	meta.RegisterRoutes(mux)
	return mux
}

func getMeta(t *testing.T, h http.Handler, remoteAddr string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/meta", nil)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var decoded map[string]any
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("response is not JSON: %v (%q)", err, rec.Body.String())
		}
	}
	return rec, decoded
}

func TestMetaDefaultsToNoGateAndNoAnnouncement(t *testing.T) {
	clock := &fakeClock{now: time.UnixMilli(1_800_000_000_123)}
	h := newTestMeta(t, ops.MetaConfig{ServerVersion: "2.0.0-alpha.4", Clock: clock.Now})

	// 公开端点：公网来源、不带任何凭据也必须可读。
	rec, body := getMeta(t, h, "203.0.113.9:50000")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	want := map[string]any{
		"server_version":     "2.0.0-alpha.4",
		"min_client_version": "",
		"announcement":       "",
		"server_time_ms":     float64(1_800_000_000_123),
	}
	if len(body) != len(want) {
		t.Fatalf("response must have exactly %d fields, got %v", len(want), body)
	}
	for key, value := range want {
		if got, ok := body[key]; !ok || got != value {
			t.Errorf("%s = %#v (present=%v), want %#v", key, got, ok, value)
		}
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestMetaReportsConfiguredGateAndAnnouncement(t *testing.T) {
	clock := &fakeClock{now: time.UnixMilli(1_800_000_000_000)}
	announcement := "本周六 02:00–03:00 维护，期间同步暂停 <b>&</b>"
	h := newTestMeta(t, ops.MetaConfig{
		ServerVersion:    "2.1.0",
		MinClientVersion: "2.0.0-alpha.4",
		Announcement:     announcement,
		Clock:            clock.Now,
	})
	_, body := getMeta(t, h, "127.0.0.1:50000")
	if body["min_client_version"] != "2.0.0-alpha.4" || body["announcement"] != announcement || body["server_version"] != "2.1.0" {
		t.Fatalf("unexpected body: %v", body)
	}

	// server_time_ms 每次响应都取当前时间。
	clock.now = clock.now.Add(90 * time.Second)
	_, later := getMeta(t, h, "127.0.0.1:50000")
	if later["server_time_ms"] != float64(1_800_000_090_000) {
		t.Fatalf("server_time_ms = %v", later["server_time_ms"])
	}
}

func TestMetaIsReadOnly(t *testing.T) {
	h := newTestMeta(t, ops.MetaConfig{ServerVersion: "2.1.0"})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/v1/meta", strings.NewReader(`{"announcement":"x"}`)))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s status = %d, want 405", method, rec.Code)
		}
	}
}

func TestMetaAnnouncementLimitIsEnforcedAtStartup(t *testing.T) {
	// 上限按 UTF-8 字节计：166 个汉字是 498 字节，167 个是 501 字节。
	accepted := []string{
		"",
		strings.Repeat("a", ops.AnnouncementMaxBytes),
		strings.Repeat("维", 166),
	}
	for _, text := range accepted {
		if _, err := ops.NewMeta(ops.MetaConfig{Announcement: text}); err != nil {
			t.Errorf("announcement of %d bytes rejected: %v", len(text), err)
		}
	}
	rejected := map[string]string{
		"one byte over":       strings.Repeat("a", ops.AnnouncementMaxBytes+1),
		"multibyte over":      strings.Repeat("维", 167),
		"newline":             "line one\nline two",
		"carriage return":     "line one\rline two",
		"terminal escape":     "upgrade now \x1b[31mred\x1b[0m",
		"nul byte":            "upgrade\x00now",
		"invalid utf-8":       "upgrade \xff now",
		"c1 control sequence": "upgrade \u009b31m now",
	}
	for name, text := range rejected {
		if _, err := ops.NewMeta(ops.MetaConfig{Announcement: text}); err == nil {
			t.Errorf("%s: announcement must be rejected", name)
		}
	}
}

func TestMetaMinClientVersionIsValidatedAtStartup(t *testing.T) {
	for _, v := range []string{"", "0.0.0", "2.0.0", "2.10.3", "2.0.0-alpha.4", "2.0.0-rc.1", "10.20.30-beta-2.x7"} {
		if err := ops.ValidateMinClientVersion(v); err != nil {
			t.Errorf("%q rejected: %v", v, err)
		}
	}
	for _, v := range []string{
		"v2.0.0", "2", "2.0", "2.0.0.0", "2.0.x", "02.0.0", "2.00.0", "2.0.0-", "2.0.0-alpha..1",
		"2.0.0-01", "2.0.0+build.5", "2.0.0-alpha+build", "latest", " 2.0.0", "2.0.0 ", "2.0.0-α",
		"2.0.0-" + strings.Repeat("a", 64),
	} {
		if err := ops.ValidateMinClientVersion(v); err == nil {
			t.Errorf("%q must be rejected", v)
		}
		if _, err := ops.NewMeta(ops.MetaConfig{MinClientVersion: v}); err == nil {
			t.Errorf("NewMeta must refuse min client version %q", v)
		}
	}
}

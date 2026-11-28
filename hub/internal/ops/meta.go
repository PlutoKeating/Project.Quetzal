// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// AnnouncementMaxBytes 是公告的 UTF-8 字节上限。
	AnnouncementMaxBytes = 500

	minClientVersionMaxBytes = 64

	// metaCacheSeconds 是 /v1/meta 的缓存时长。server_time_ms 因此最多滞后这么久，
	// 远小于时钟偏移判定用的分钟级容差。
	metaCacheSeconds = 60
)

// MetaConfig 配置 /v1/meta。
type MetaConfig struct {
	ServerVersion string
	// MinClientVersion 为空表示不设门槛；否则必须是 `主.次.修订[-预发布]` 形式的语义化版本。
	MinClientVersion string
	// Announcement 为空表示没有公告；否则是不超过 AnnouncementMaxBytes 的单行纯文本。
	Announcement string
	Clock        func() time.Time
}

// Meta 是公开、无需鉴权的元信息端点，供客户端做升级提示与最低版本门控。
type Meta struct {
	cfg MetaConfig
}

type metaResponse struct {
	ServerVersion    string `json:"server_version"`
	MinClientVersion string `json:"min_client_version"`
	Announcement     string `json:"announcement"`
	ServerTimeMs     int64  `json:"server_time_ms"`
}

func isDecimalIdent(s string) bool {
	if s == "" || (len(s) > 1 && s[0] == '0') {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isPrereleaseIdent(s string) bool {
	if s == "" {
		return false
	}
	numeric := true
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-':
			numeric = false
		default:
			return false
		}
	}
	return !numeric || isDecimalIdent(s)
}

// ValidateMinClientVersion 接受空串或 `主.次.修订[-预发布]`。不接受 `v` 前缀与 `+构建` 后缀：
// 写错的门槛要么把所有客户端挡在外面，要么悄悄失效，所以启动时就拒绝。
func ValidateMinClientVersion(v string) error {
	if v == "" {
		return nil
	}
	if len(v) > minClientVersionMaxBytes {
		return fmt.Errorf("min client version is %d bytes, the limit is %d", len(v), minClientVersionMaxBytes)
	}
	invalid := fmt.Errorf("min client version %q is not MAJOR.MINOR.PATCH[-PRERELEASE] (for example 2.0.0 or 2.0.0-alpha.4)", v)
	core, prerelease, hasPrerelease := strings.Cut(v, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return invalid
	}
	for _, part := range parts {
		if !isDecimalIdent(part) {
			return invalid
		}
	}
	if hasPrerelease {
		for _, ident := range strings.Split(prerelease, ".") {
			if !isPrereleaseIdent(ident) {
				return invalid
			}
		}
	}
	return nil
}

// ValidateAnnouncement 要求公告是不超过 AnnouncementMaxBytes 的单行 UTF-8 纯文本。
// 客户端会把它显示在终端与状态栏里，所以不允许任何控制字符（含换行与转义序列）。
func ValidateAnnouncement(text string) error {
	if len(text) > AnnouncementMaxBytes {
		return fmt.Errorf("announcement is %d bytes, the limit is %d", len(text), AnnouncementMaxBytes)
	}
	if !utf8.ValidString(text) {
		return errors.New("announcement must be valid UTF-8")
	}
	for _, r := range text {
		if unicode.IsControl(r) {
			return errors.New("announcement must be a single line without control characters")
		}
	}
	return nil
}

func NewMeta(cfg MetaConfig) (*Meta, error) {
	if err := ValidateMinClientVersion(cfg.MinClientVersion); err != nil {
		return nil, err
	}
	if err := ValidateAnnouncement(cfg.Announcement); err != nil {
		return nil, err
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	return &Meta{cfg: cfg}, nil
}

func (m *Meta) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/meta", m.handle)
}

func (m *Meta) handle(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", metaCacheSeconds))
	// 公开且不带凭据，允许网页端跨源读取。
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(metaResponse{
		ServerVersion:    m.cfg.ServerVersion,
		MinClientVersion: m.cfg.MinClientVersion,
		Announcement:     m.cfg.Announcement,
		ServerTimeMs:     m.cfg.Clock().UnixMilli(),
	})
}

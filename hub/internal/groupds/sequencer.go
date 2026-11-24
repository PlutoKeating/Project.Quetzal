// SPDX-License-Identifier: AGPL-3.0-only

// Package groupds 实现零知识群组密文提交原子定序器：
// 只保存 openmls 密文与可审计元数据（群 ID、server_seq、mls_epoch、因果父序号、
// 发送设备、不可解析的 mentions 数组与时间戳），绝不落盘任何明文提示词、记忆或人格内容。
package groupds

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

const (
	maxGroupBodyBytes  = 256 * 1024
	defaultCommitLimit = 200
	maxCommitLimit     = 1000
)

type Service struct {
	store store.Store
	auth  *auth.Service
	clock func() time.Time
}

func NewService(st store.Store, authSvc *auth.Service, clock func() time.Time) (*Service, error) {
	if st == nil || authSvc == nil {
		return nil, errors.New("store and auth service are required")
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{store: st, auth: authSvc, clock: clock}, nil
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/groups", s.handleCreateGroup)
	mux.HandleFunc("GET /v1/groups", s.handleListGroups)
	mux.HandleFunc("POST /v1/groups/{group_id}/members", s.handleAddMember)
	mux.HandleFunc("GET /v1/groups/{group_id}/members", s.handleListMembers)
	mux.HandleFunc("POST /v1/groups/{group_id}/commits", s.handleAppendCommit)
	mux.HandleFunc("GET /v1/groups/{group_id}/commits", s.handleListCommits)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, map[string]any{"code": code, "detail": detail})
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxGroupBodyBytes))
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "invalid JSON body")
		return false
	}
	return true
}

func (s *Service) requireRoomMember(w http.ResponseWriter, r *http.Request, groupID, agentID string) (*store.GroupRoom, *store.GroupMember, bool) {
	room, err := s.store.GetGroupRoom(r.Context(), groupID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "PERMISSION_DENIED", "group not found")
		return nil, nil, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "group lookup failed")
		return nil, nil, false
	}
	member, err := s.store.GetGroupMember(r.Context(), groupID, agentID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "agent is not a member of this group")
		return nil, nil, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "group membership lookup failed")
		return nil, nil, false
	}
	return room, member, true
}

func validRole(role string) bool {
	return role == "owner" || role == "steward" || role == "member"
}

func canInvite(role string) bool {
	return role == "owner" || role == "steward"
}

func (s *Service) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}
	var req struct {
		GroupID      string `json:"group_id"`
		OwnerAgentID string `json:"owner_agent_id"`
		SecrecyLevel int    `json:"secrecy_level"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	groupID := strings.TrimSpace(req.GroupID)
	owner := strings.TrimSpace(req.OwnerAgentID)
	if groupID == "" || owner == "" {
		writeError(w, http.StatusBadRequest, "INVALID_ID", "group_id and owner_agent_id are required")
		return
	}
	if owner != principal.AgentID {
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "owner_agent_id must match authenticated agent")
		return
	}
	if req.SecrecyLevel < 0 || req.SecrecyLevel > 5 {
		writeError(w, http.StatusBadRequest, "INVALID_ID", "secrecy_level must be between 0 and 5")
		return
	}
	nowMs := s.clock().UnixMilli()
	room := store.GroupRoom{
		GroupID:      groupID,
		OwnerAgentID: owner,
		SecrecyLevel: req.SecrecyLevel,
		CreatedAtMs:  nowMs,
	}
	if err := s.store.CreateGroupRoom(r.Context(), room); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusConflict, "PERMISSION_DENIED", "group already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "create group failed")
		return
	}
	if err := s.store.AddGroupMember(r.Context(), store.GroupMember{
		GroupID:   groupID,
		AgentID:   owner,
		Role:      "owner",
		AddedAtMs: nowMs,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "create owner membership failed")
		return
	}
	writeJSON(w, http.StatusCreated, room)
}

func (s *Service) handleListGroups(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}
	rooms, err := s.store.ListGroupRooms(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "list groups failed")
		return
	}
	visible := make([]store.GroupRoom, 0, len(rooms))
	for _, room := range rooms {
		if _, err := s.store.GetGroupMember(r.Context(), room.GroupID, principal.AgentID); err == nil {
			visible = append(visible, room)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": visible})
}

func (s *Service) handleAddMember(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}
	groupID := strings.TrimSpace(r.PathValue("group_id"))
	_, caller, ok := s.requireRoomMember(w, r, groupID, principal.AgentID)
	if !ok {
		return
	}
	if !canInvite(caller.Role) {
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "only owner or steward may invite group members")
		return
	}
	var req struct {
		AgentID string `json:"agent_id"`
		Role    string `json:"role"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	agentID := strings.TrimSpace(req.AgentID)
	role := strings.TrimSpace(req.Role)
	if agentID == "" || !validRole(role) {
		writeError(w, http.StatusBadRequest, "INVALID_ID", "agent_id and a valid role are required")
		return
	}
	if role == "owner" {
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "owner role cannot be delegated through invite")
		return
	}
	member := store.GroupMember{
		GroupID:   groupID,
		AgentID:   agentID,
		Role:      role,
		AddedAtMs: s.clock().UnixMilli(),
	}
	if err := s.store.AddGroupMember(r.Context(), member); err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "add member failed")
		return
	}
	writeJSON(w, http.StatusCreated, member)
}

func (s *Service) handleListMembers(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}
	groupID := strings.TrimSpace(r.PathValue("group_id"))
	_, _, ok = s.requireRoomMember(w, r, groupID, principal.AgentID)
	if !ok {
		return
	}
	members, err := s.store.ListGroupMembers(r.Context(), groupID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "list members failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

type appendCommitRequest struct {
	MLSEpoch        uint64          `json:"mls_epoch"`
	CausalParentSeq uint64          `json:"causal_parent_seq"`
	SenderAgentID   string          `json:"sender_agent_id"`
	SenderDeviceID  string          `json:"sender_device_id"`
	Mentions        json.RawMessage `json:"mentions"`
	CiphertextB64   string          `json:"ciphertext_b64"`
}

func (s *Service) handleAppendCommit(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}
	groupID := strings.TrimSpace(r.PathValue("group_id"))
	_, _, ok = s.requireRoomMember(w, r, groupID, principal.AgentID)
	if !ok {
		return
	}
	var req appendCommitRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.SenderAgentID) != principal.AgentID ||
		strings.TrimSpace(req.SenderDeviceID) != principal.DeviceID {
		writeError(w, http.StatusForbidden, "PERMISSION_DENIED", "sender identity does not match authenticated principal")
		return
	}
	ciphertext, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.CiphertextB64))
	if err != nil || len(ciphertext) == 0 {
		writeError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "ciphertext_b64 must be non-empty base64")
		return
	}
	mentionsJSON := "[]"
	if len(req.Mentions) > 0 && string(req.Mentions) != "null" {
		var parsed []json.RawMessage
		if err := json.Unmarshal(req.Mentions, &parsed); err != nil {
			writeError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "mentions must be a JSON array")
			return
		}
		normalized, err := json.Marshal(parsed)
		if err != nil {
			writeError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "mentions normalization failed")
			return
		}
		mentionsJSON = string(normalized)
	}
	commit := store.GroupCommit{
		GroupID:         groupID,
		MLSEpoch:        req.MLSEpoch,
		CausalParentSeq: req.CausalParentSeq,
		SenderAgentID:   principal.AgentID,
		SenderDeviceID:  principal.DeviceID,
		MentionsJSON:    mentionsJSON,
		CiphertextB64:   base64.StdEncoding.EncodeToString(ciphertext),
		CreatedAtMs:     s.clock().UnixMilli(),
	}
	stored, err := s.store.AppendGroupCommit(r.Context(), commit)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "PERMISSION_DENIED", "group not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "append commit failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"group_id":          stored.GroupID,
		"server_seq":        stored.ServerSeq,
		"mls_epoch":         stored.MLSEpoch,
		"causal_parent_seq": stored.CausalParentSeq,
		"sender_agent_id":   stored.SenderAgentID,
		"sender_device_id":  stored.SenderDeviceID,
		"created_at_ms":     stored.CreatedAtMs,
	})
}

func (s *Service) handleListCommits(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.auth.RequireAuth(w, r)
	if !ok {
		return
	}
	groupID := strings.TrimSpace(r.PathValue("group_id"))
	_, _, ok = s.requireRoomMember(w, r, groupID, principal.AgentID)
	if !ok {
		return
	}
	var afterSeq uint64
	if raw := strings.TrimSpace(r.URL.Query().Get("after_seq")); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "INVALID_ID", "after_seq must be an unsigned integer")
			return
		}
		afterSeq = parsed
	}
	limit := defaultCommitLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "INVALID_ID", "limit must be a positive integer")
			return
		}
		if parsed > maxCommitLimit {
			parsed = maxCommitLimit
		}
		limit = parsed
	}
	commits, err := s.store.ListGroupCommits(r.Context(), groupID, afterSeq, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORAGE_ERROR", "list commits failed")
		return
	}
	rows := make([]map[string]any, 0, len(commits))
	for _, commit := range commits {
		rows = append(rows, map[string]any{
			"group_id":          commit.GroupID,
			"server_seq":        commit.ServerSeq,
			"mls_epoch":         commit.MLSEpoch,
			"causal_parent_seq": commit.CausalParentSeq,
			"sender_agent_id":   commit.SenderAgentID,
			"sender_device_id":  commit.SenderDeviceID,
			"mentions":          json.RawMessage(commit.MentionsJSON),
			"ciphertext_b64":    commit.CiphertextB64,
			"created_at_ms":     commit.CreatedAtMs,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"commits": rows, "head_group_seq": headSeq(commits, afterSeq)})
}

func headSeq(commits []store.GroupCommit, afterSeq uint64) uint64 {
	head := afterSeq
	for _, commit := range commits {
		if commit.ServerSeq > head {
			head = commit.ServerSeq
		}
	}
	return head
}

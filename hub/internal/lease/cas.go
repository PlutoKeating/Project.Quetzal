// SPDX-License-Identifier: AGPL-3.0-only

package lease

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

type Service struct {
	store        store.Store
	auth         *auth.Service
	defaultTTLMs int64
	maxTTLMs     int64
	clock        func() time.Time
}

func NewService(st store.Store, authSvc *auth.Service, defaultTTLMs, maxTTLMs int64, clock func() time.Time) (*Service, error) {
	if st == nil || authSvc == nil {
		return nil, errors.New("store and auth service are required")
	}
	if defaultTTLMs <= 0 {
		defaultTTLMs = 30_000
	}
	if maxTTLMs < defaultTTLMs {
		maxTTLMs = 120_000
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		store:        st,
		auth:         authSvc,
		defaultTTLMs: defaultTTLMs,
		maxTTLMs:     maxTTLMs,
		clock:        clock,
	}, nil
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/lease/acquire", s.handleAcquire)
	mux.HandleFunc("POST /v1/lease/renew", s.handleRenew)
	mux.HandleFunc("POST /v1/lease/release", s.handleRelease)
}

func (s *Service) clampTTL(ttlMs int64) int64 {
	if ttlMs <= 0 {
		return s.defaultTTLMs
	}
	if ttlMs < 1_000 {
		return 1_000
	}
	if ttlMs > s.maxTTLMs {
		return s.maxTTLMs
	}
	return ttlMs
}

func writeLeaseJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeLeaseError(w http.ResponseWriter, err error) {
	var staleErr *store.StaleLeaseError
	if errors.As(err, &staleErr) {
		writeLeaseJSON(w, http.StatusConflict, map[string]any{
			"code":             "STALE_LEASE_EPOCH",
			"provided":         staleErr.Provided,
			"current":          staleErr.Current,
			"holder_device_id": staleErr.Holder,
		})
		return
	}
	writeLeaseJSON(w, http.StatusInternalServerError, map[string]any{
		"code":   "STORAGE_ERROR",
		"detail": err.Error(),
	})
}

func (s *Service) verifyCallerDevice(w http.ResponseWriter, r *http.Request, agentID, deviceID string) bool {
	principal, _, ok := s.auth.RequireAgentOwner(w, r, agentID)
	if !ok {
		return false
	}
	if deviceID == "" {
		writeLeaseJSON(w, http.StatusBadRequest, map[string]string{
			"code":   "INVALID_ID",
			"detail": "missing device_id",
		})
		return false
	}
	if principal.AgentID == agentID && principal.DeviceID != "" && principal.DeviceID != deviceID {
		writeLeaseJSON(w, http.StatusForbidden, map[string]string{
			"code":   "PERMISSION_DENIED",
			"detail": "session device_id does not match requested device_id",
		})
		return false
	}
	dev, err := s.store.GetDevice(r.Context(), agentID, deviceID)
	if err != nil || dev.Revoked {
		writeLeaseJSON(w, http.StatusForbidden, map[string]string{
			"code":   "PERMISSION_DENIED",
			"detail": "device is not active for agent",
		})
		return false
	}
	return true
}

func (s *Service) handleAcquire(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req struct {
		AgentID       string `json:"agent_id"`
		DeviceID      string `json:"device_id"`
		ExpectedEpoch uint64 `json:"expected_epoch"`
		TTLMs         int64  `json:"ttl_ms"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&req); err != nil {
		writeLeaseJSON(w, http.StatusBadRequest, map[string]string{"code": "SERIALIZATION_ERROR", "detail": err.Error()})
		return
	}
	if !s.verifyCallerDevice(w, r, req.AgentID, req.DeviceID) {
		return
	}
	rec, err := s.store.AcquireLease(r.Context(), req.AgentID, req.DeviceID, req.ExpectedEpoch, s.clampTTL(req.TTLMs), s.clock().UnixMilli())
	if err != nil {
		writeLeaseError(w, err)
		return
	}
	writeLeaseJSON(w, http.StatusOK, rec)
}

func (s *Service) handleRenew(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req struct {
		AgentID      string `json:"agent_id"`
		DeviceID     string `json:"device_id"`
		WitnessEpoch uint64 `json:"witness_epoch"`
		TTLMs        int64  `json:"ttl_ms"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&req); err != nil {
		writeLeaseJSON(w, http.StatusBadRequest, map[string]string{"code": "SERIALIZATION_ERROR", "detail": err.Error()})
		return
	}
	if !s.verifyCallerDevice(w, r, req.AgentID, req.DeviceID) {
		return
	}
	rec, err := s.store.RenewLease(r.Context(), req.AgentID, req.DeviceID, req.WitnessEpoch, s.clampTTL(req.TTLMs), s.clock().UnixMilli())
	if err != nil {
		writeLeaseError(w, err)
		return
	}
	writeLeaseJSON(w, http.StatusOK, rec)
}

func (s *Service) handleRelease(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req struct {
		AgentID      string `json:"agent_id"`
		DeviceID     string `json:"device_id"`
		WitnessEpoch uint64 `json:"witness_epoch"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 32*1024)).Decode(&req); err != nil {
		writeLeaseJSON(w, http.StatusBadRequest, map[string]string{"code": "SERIALIZATION_ERROR", "detail": err.Error()})
		return
	}
	if !s.verifyCallerDevice(w, r, req.AgentID, req.DeviceID) {
		return
	}
	rec, err := s.store.ReleaseLease(r.Context(), req.AgentID, req.DeviceID, req.WitnessEpoch, s.clock().UnixMilli())
	if err != nil {
		writeLeaseError(w, err)
		return
	}
	writeLeaseJSON(w, http.StatusOK, rec)
}

// SPDX-License-Identifier: AGPL-3.0-only

package spine

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

const (
	MaxFutureClockDriftMs = 300_000
	MinBucketBytes        = 256
	DefaultMaxPackBytes   = 16 * 1024 * 1024
	presignTTL            = 15 * time.Minute
)

type Service struct {
	store        store.Store
	blobs        store.BlobStore
	auth         *auth.Service
	maxPackBytes int64
	clock        func() time.Time
}

func NewService(st store.Store, blobs store.BlobStore, authSvc *auth.Service, maxPackBytes int64, clock func() time.Time) (*Service, error) {
	if st == nil || blobs == nil || authSvc == nil {
		return nil, errors.New("store, blobs, and auth service are required")
	}
	if maxPackBytes <= 0 {
		maxPackBytes = DefaultMaxPackBytes
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		store:        st,
		blobs:        blobs,
		auth:         authSvc,
		maxPackBytes: maxPackBytes,
		clock:        clock,
	}, nil
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/spine/{agent_id}/packs/presign", s.handlePresign)
	mux.HandleFunc("POST /v1/spine/{agent_id}/packs/commit", s.handleCommit)
	mux.HandleFunc("GET /v1/spine/{agent_id}/packs", s.handleList)
}

func isHexLen(str string, byteLen int) bool {
	b, err := hex.DecodeString(str)
	return err == nil && len(b) == byteLen
}

func parseHLC128(hlcHex string) ([16]byte, uint64, error) {
	var out [16]byte
	b, err := hex.DecodeString(hlcHex)
	if err != nil || len(b) != 16 {
		return out, 0, errors.New("HLC must be 32 hex chars (128-bit)")
	}
	copy(out[:], b)
	wallMs := binary.BigEndian.Uint64(out[0:8])
	return out, wallMs, nil
}

func writeSpineJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeSpineError(w http.ResponseWriter, status int, code, detail string) {
	writeSpineJSON(w, status, map[string]any{
		"code":   code,
		"detail": detail,
	})
}

func (s *Service) handlePresign(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	_, ag, ok := s.auth.RequireAgentOwner(w, r, agentID)
	if !ok {
		return
	}

	defer r.Body.Close()
	var req struct {
		PackID        string `json:"pack_id"`
		ContentLength int64  `json:"content_length"`
		SHA256Hex     string `json:"sha256_hex"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		writeSpineError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if !isHexLen(req.PackID, 32) || !isHexLen(req.SHA256Hex, 32) || req.ContentLength <= 0 {
		writeSpineError(w, http.StatusBadRequest, "INVALID_ID", "invalid pack_id, sha256_hex, or content_length")
		return
	}
	if req.ContentLength > s.maxPackBytes {
		writeSpineError(w, http.StatusRequestEntityTooLarge, "STORAGE_ERROR", "pack exceeds max allowed size")
		return
	}
	if ag.UsedBytes+req.ContentLength > ag.QuotaBytes {
		writeSpineError(w, http.StatusRequestEntityTooLarge, "STORAGE_ERROR", "per-agent storage quota exceeded")
		return
	}

	var idBytes [16]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		writeSpineError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	uploadID := hex.EncodeToString(idBytes[:])
	packLower := strings.ToLower(req.PackID)
	shaLower := strings.ToLower(req.SHA256Hex)
	blobKey := fmt.Sprintf("agents/%s/packs/%s.pack", agentID, packLower)

	now := s.clock()
	expAtMs := now.Add(presignTTL).UnixMilli()
	if err := s.store.CreatePackUpload(r.Context(), store.PackUpload{
		UploadID:      uploadID,
		AgentID:       agentID,
		PackID:        packLower,
		ContentLength: req.ContentLength,
		SHA256Hex:     shaLower,
		BlobKey:       blobKey,
		ExpiresAtMs:   expAtMs,
	}); err != nil {
		writeSpineError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}

	putURL, headers, err := s.blobs.PresignPut(r.Context(), uploadID, blobKey, req.ContentLength, shaLower, presignTTL, now)
	if err != nil {
		writeSpineError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeSpineJSON(w, http.StatusOK, map[string]any{
		"upload_id":        uploadID,
		"put_url":          putURL,
		"required_headers": headers,
		"expires_at_ms":    expAtMs,
	})
}

func (s *Service) handleCommit(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	principal, _, ok := s.auth.RequireAgentOwner(w, r, agentID)
	if !ok {
		return
	}

	defer r.Body.Close()
	var req struct {
		UploadID        string        `json:"upload_id"`
		PackID          string        `json:"pack_id"`
		AAD             store.PackAad `json:"aad"`
		AADUTF8         string        `json:"aad_utf8"`
		DEKWrapNonceHex string        `json:"dek_wrap_nonce_hex"`
		WrappedDEKHex   string        `json:"wrapped_dek_hex"`
		PackNonceHex    string        `json:"pack_nonce_hex"`
		ContentLength   int64         `json:"content_length"`
		SHA256Hex       string        `json:"sha256_hex"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256*1024)).Decode(&req); err != nil {
		writeSpineError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}

	if req.UploadID == "" || !isHexLen(req.PackID, 32) || !isHexLen(req.SHA256Hex, 32) {
		writeSpineError(w, http.StatusBadRequest, "INVALID_ID", "invalid upload_id, pack_id, or sha256_hex")
		return
	}
	if req.ContentLength <= 0 || req.ContentLength > s.maxPackBytes {
		writeSpineError(w, http.StatusRequestEntityTooLarge, "STORAGE_ERROR", "invalid content_length")
		return
	}
	if !isHexLen(req.DEKWrapNonceHex, 24) || !isHexLen(req.WrappedDEKHex, 48) || !isHexLen(req.PackNonceHex, 24) {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid DEK wrap or pack nonce lengths")
		return
	}

	// Validate SpinePackAAD fields, CRIME power-of-two bucket padding, and canonical JSON binding
	if req.AAD.V != 2 || req.AAD.AgentID != agentID {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "AAD agent_id or version mismatch")
		return
	}
	if req.AAD.Compartment != "core" && req.AAD.Compartment != "external_channel" {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "AAD compartment must be core or external_channel")
		return
	}
	if req.AAD.PaddedLen < MinBucketBytes || (req.AAD.PaddedLen&(req.AAD.PaddedLen-1)) != 0 {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "AAD padded_len must be a power of two >= 256")
		return
	}
	if int64(req.AAD.PaddedLen)+16 != req.ContentLength {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "ciphertext content_length must equal padded_len + 16")
		return
	}
	if req.AAD.FirstSeq == 0 || req.AAD.FirstSeq > req.AAD.LastSeq {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid first_seq..last_seq range")
		return
	}
	if !isHexLen(req.AAD.UncompressedBlake3, 32) {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid uncompressed_blake3")
		return
	}
	if req.AADUTF8 != req.AAD.CanonicalJSON() {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "AAD canonical JSON mismatch")
		return
	}
	if principal.AgentID == agentID && principal.DeviceID != "" && principal.DeviceID != req.AAD.DeviceID {
		writeSpineError(w, http.StatusForbidden, "PERMISSION_DENIED", "AAD device_id does not match authenticated device")
		return
	}
	aadDev, err := s.store.GetDevice(r.Context(), agentID, req.AAD.DeviceID)
	if err != nil || aadDev.Revoked {
		writeSpineError(w, http.StatusForbidden, "PERMISSION_DENIED", "AAD device_id is unregistered or revoked")
		return
	}

	minHLCBytes, minWallMs, err := parseHLC128(req.AAD.MinHLC)
	if err != nil {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	maxHLCBytes, maxWallMs, err := parseHLC128(req.AAD.MaxHLC)
	if err != nil {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	if bytes.Compare(minHLCBytes[:], maxHLCBytes[:]) > 0 {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "min_hlc > max_hlc")
		return
	}

	// Pitfall #10: Reject future HLC clock drift poisoning (> server_now + 5m)
	now := s.clock()
	nowWallMs := uint64(now.UnixMilli())
	for _, remoteWall := range []uint64{minWallMs, maxWallMs} {
		if remoteWall > nowWallMs+MaxFutureClockDriftMs {
			writeSpineJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"code":           "CLOCK_DRIFT_EXCEEDED",
				"remote_wall_ms": remoteWall,
				"local_wall_ms":  nowWallMs,
				"max_drift_ms":   uint64(MaxFutureClockDriftMs),
			})
			return
		}
	}

	packLower := strings.ToLower(req.PackID)
	shaLower := strings.ToLower(req.SHA256Hex)
	blobKey := fmt.Sprintf("agents/%s/packs/%s.pack", agentID, packLower)

	blobMeta, err := s.blobs.StatVerifiedBlob(r.Context(), blobKey)
	if err != nil {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "uploaded blob missing or unverified")
		return
	}
	if blobMeta.ContentLength != req.ContentLength || blobMeta.SHA256Hex != shaLower {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "stored blob size or SHA-256 mismatch")
		return
	}
	if blobMeta.Blake3Hex != "" && blobMeta.Blake3Hex != packLower {
		writeSpineError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "stored blob BLAKE3 pack_id mismatch")
		return
	}
	if err := s.store.MarkPackUploaded(r.Context(), req.UploadID); err != nil && !errors.Is(err, store.ErrNotFound) {
		writeSpineError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}

	committed, err := s.store.CommitSpinePack(r.Context(), req.UploadID, store.SpinePackRecord{
		AgentID:               agentID,
		PackID:                packLower,
		DeviceID:              req.AAD.DeviceID,
		Compartment:           req.AAD.Compartment,
		Epoch:                 req.AAD.Epoch,
		FirstSeq:              req.AAD.FirstSeq,
		LastSeq:               req.AAD.LastSeq,
		MinHLCHex:             strings.ToLower(req.AAD.MinHLC),
		MaxHLCHex:             strings.ToLower(req.AAD.MaxHLC),
		PaddedLen:             req.AAD.PaddedLen,
		UncompressedBlake3Hex: strings.ToLower(req.AAD.UncompressedBlake3),
		AADUTF8:               req.AADUTF8,
		DEKWrapNonceHex:       strings.ToLower(req.DEKWrapNonceHex),
		WrappedDEKHex:         strings.ToLower(req.WrappedDEKHex),
		PackNonceHex:          strings.ToLower(req.PackNonceHex),
		ContentLength:         req.ContentLength,
		SHA256Hex:             shaLower,
		CreatedAtMs:           now.UnixMilli(),
	})
	if err != nil {
		if errors.Is(err, store.ErrQuotaExceeded) {
			writeSpineError(w, http.StatusTooManyRequests, "STORAGE_ERROR", "per-agent storage quota exceeded")
			return
		}
		writeSpineError(w, http.StatusConflict, "INTEGRITY_VIOLATION", err.Error())
		return
	}

	writeSpineJSON(w, http.StatusOK, map[string]any{
		"server_seq": committed.ServerSeq,
		"pack_id":    committed.PackID,
	})
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.auth.RequireAgentOwner(w, r, agentID); !ok {
		return
	}

	q := r.URL.Query()
	var afterSeq uint64
	if rawAfter := q.Get("after_seq"); rawAfter != "" {
		v, err := strconv.ParseUint(rawAfter, 10, 64)
		if err != nil {
			writeSpineError(w, http.StatusBadRequest, "INVALID_ID", "invalid after_seq")
			return
		}
		afterSeq = v
	}
	var limit uint32 = 100
	if rawLimit := q.Get("limit"); rawLimit != "" {
		v, err := strconv.ParseUint(rawLimit, 10, 32)
		if err != nil || v == 0 {
			writeSpineError(w, http.StatusBadRequest, "INVALID_ID", "invalid limit")
			return
		}
		limit = uint32(v)
	}

	packs, err := s.store.ListSpinePacks(r.Context(), agentID, afterSeq, limit)
	if err != nil {
		writeSpineError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	now := s.clock()
	for i := range packs {
		dlURL, err := s.blobs.PresignGet(r.Context(), packs[i].BlobKey, presignTTL, now)
		if err != nil {
			writeSpineError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
			return
		}
		packs[i].DownloadURL = dlURL
	}
	if packs == nil {
		packs = []store.SpinePackRecord{}
	}
	writeSpineJSON(w, http.StatusOK, map[string]any{
		"packs": packs,
	})
}

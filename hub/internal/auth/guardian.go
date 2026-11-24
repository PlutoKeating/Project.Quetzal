// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"lukechampine.com/blake3"
	"quetzalcoatl-hub/internal/store"
)

const (
	shamirCommitmentContext = "quetzalcoatl/v2/shamir-root-commitment-v1"
	guardianRecoveryTTLMs   = 30 * 60 * 1000
)

type ShamirShare struct {
	Index            uint8
	Threshold        uint8
	Value            [32]byte
	CommitmentBlake3 [32]byte
}

func gf256Add(a, b uint8) uint8 {
	return a ^ b
}

func gf256Mul(a, b uint8) uint8 {
	var acc uint8
	for i := 0; i < 8; i++ {
		mask := uint8(0) - (b & 1)
		acc ^= a & mask
		hiBit := a & 0x80
		a <<= 1
		redMask := uint8(0) - (hiBit >> 7)
		a ^= 0x1b & redMask
		b >>= 1
	}
	return acc
}

func gf256Inv(x uint8) (uint8, error) {
	if x == 0 {
		return 0, errors.New("INTEGRITY_VIOLATION: GF(256) zero inverse")
	}
	res := uint8(1)
	base := x
	exp := uint8(254)
	for exp > 0 {
		if (exp & 1) != 0 {
			res = gf256Mul(res, base)
		}
		base = gf256Mul(base, base)
		exp >>= 1
	}
	return res, nil
}

func gf256EvalPoly(coeffs []uint8, x uint8) uint8 {
	var acc uint8
	for i := len(coeffs) - 1; i >= 0; i-- {
		acc = gf256Add(gf256Mul(acc, x), coeffs[i])
	}
	return acc
}

func SplitShamirShares(secret [32]byte, threshold, total uint8) ([]ShamirShare, error) {
	if threshold < 2 || total < threshold {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: invalid Shamir threshold=%d total=%d", threshold, total)
	}
	var commitment [32]byte
	blake3.DeriveKey(commitment[:], shamirCommitmentContext, secret[:])

	degree := int(threshold - 1)
	shareValues := make([][32]byte, int(total))
	coeffs := make([]uint8, degree+1)
	defer clear(coeffs)

	for byteIdx, secretByte := range secret {
		coeffs[0] = secretByte
		if _, err := rand.Read(coeffs[1:]); err != nil {
			return nil, err
		}
		for sIdx := range shareValues {
			x := uint8(sIdx + 1)
			shareValues[sIdx][byteIdx] = gf256EvalPoly(coeffs, x)
		}
	}

	out := make([]ShamirShare, int(total))
	for i := range shareValues {
		out[i] = ShamirShare{
			Index:            uint8(i + 1),
			Threshold:        threshold,
			Value:            shareValues[i],
			CommitmentBlake3: commitment,
		}
	}
	return out, nil
}

func ReconstructShamirShares(shares []ShamirShare) ([32]byte, error) {
	var secret [32]byte
	if len(shares) == 0 {
		return secret, errors.New("INTEGRITY_VIOLATION: empty Shamir share list")
	}
	k := int(shares[0].Threshold)
	if k < 2 || len(shares) < k {
		return secret, errors.New("INTEGRITY_VIOLATION: insufficient Shamir shares")
	}
	used := shares[:k]
	for i, s := range used {
		if s.Index == 0 {
			return secret, errors.New("INTEGRITY_VIOLATION: Shamir index 0 disallowed")
		}
		if s.Threshold != used[0].Threshold || s.CommitmentBlake3 != used[0].CommitmentBlake3 {
			return secret, errors.New("INTEGRITY_VIOLATION: Shamir commitment mismatch")
		}
		for _, other := range used[i+1:] {
			if s.Index == other.Index {
				return secret, errors.New("INTEGRITY_VIOLATION: duplicate Shamir index")
			}
		}
	}

	for byteIdx := 0; byteIdx < 32; byteIdx++ {
		var acc uint8
		for i, si := range used {
			num := uint8(1)
			den := uint8(1)
			for j, sj := range used {
				if i == j {
					continue
				}
				num = gf256Mul(num, sj.Index)
				den = gf256Mul(den, gf256Add(si.Index, sj.Index))
			}
			invDen, err := gf256Inv(den)
			if err != nil {
				clear(secret[:])
				return [32]byte{}, err
			}
			basis := gf256Mul(num, invDen)
			acc = gf256Add(acc, gf256Mul(si.Value[byteIdx], basis))
		}
		secret[byteIdx] = acc
	}

	var verifyCommitment [32]byte
	blake3.DeriveKey(verifyCommitment[:], shamirCommitmentContext, secret[:])
	if verifyCommitment != used[0].CommitmentBlake3 {
		clear(secret[:])
		return [32]byte{}, errors.New("INTEGRITY_VIOLATION: Shamir BLAKE3 commitment mismatch")
	}
	return secret, nil
}

func (s *Service) handleGuardianSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID             string                       `json:"agent_id"`
		Threshold           int                          `json:"threshold"`
		Total               int                          `json:"total"`
		CommitmentBlake3Hex string                       `json:"commitment_blake3_hex"`
		Shares              []store.GuardianShareCustody `json:"shares"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if _, _, ok := s.requireAgentOwner(w, r, req.AgentID); !ok {
		return
	}
	if req.Threshold < 2 || req.Total < req.Threshold || len(req.Shares) != req.Total {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid threshold/total guardian share count")
		return
	}
	if _, err := decodeHexFixed32(req.CommitmentBlake3Hex); err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid commitment_blake3_hex")
		return
	}
	seenIdx := make(map[int]bool)
	for i := range req.Shares {
		sh := &req.Shares[i]
		sh.AgentID = req.AgentID
		if sh.ShareIndex < 1 || sh.ShareIndex > 255 || seenIdx[sh.ShareIndex] {
			writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid or duplicate share_index")
			return
		}
		seenIdx[sh.ShareIndex] = true
		if _, err := decodeHexFixed32(sh.GuardianPubKeyHex); err != nil {
			writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid guardian_pubkey_hex")
			return
		}
		encShare, err := hex.DecodeString(sh.EncryptedShareHex)
		// Encrypted share MUST include AEAD tag (48B for 32B share + 16B tag), never raw 32B plaintext!
		if err != nil || len(encShare) < 48 {
			writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "guardian share must be AEAD/HPKE encrypted (>=48B)")
			return
		}
	}
	nowMs := s.clock().UnixMilli()
	if err := s.store.SaveGuardianSetup(r.Context(), store.GuardianConfig{
		AgentID:             req.AgentID,
		Threshold:           req.Threshold,
		Total:               req.Total,
		CommitmentBlake3Hex: strings.ToLower(req.CommitmentBlake3Hex),
		UpdatedAtMs:         nowMs,
	}, req.Shares); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "configured"})
}

func (s *Service) handleGuardianRecoverRequest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID             string `json:"agent_id"`
		RequesterXWingPKHex string `json:"requester_xwing_pk_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	xwBytes, err := hex.DecodeString(req.RequesterXWingPKHex)
	if err != nil || len(xwBytes) != XWingPKLen {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "requester_xwing_pk_hex must be 1216 bytes")
		return
	}
	if _, _, err := s.store.GetGuardianSetup(r.Context(), req.AgentID); err != nil {
		writeAPIError(w, http.StatusNotFound, "INVALID_ID", "guardian setup not found")
		return
	}
	recID, err := randomIDHex(16)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	expMs := nowMs + guardianRecoveryTTLMs
	if err := s.store.CreateGuardianRecovery(r.Context(), store.GuardianRecovery{
		RecoveryID:          recID,
		AgentID:             req.AgentID,
		RequesterXWingPKHex: strings.ToLower(req.RequesterXWingPKHex),
		ExpiresAtMs:         expMs,
		CreatedAtMs:         nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recovery_id":   recID,
		"expires_at_ms": expMs,
	})
}

func (s *Service) handleGuardianRecoverApprove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RecoveryID          string `json:"recovery_id"`
		AgentID             string `json:"agent_id"`
		ShareIndex          int    `json:"share_index"`
		GuardianID          string `json:"guardian_id"`
		SignatureHex        string `json:"signature_hex"`
		RewrappedShareHex   string `json:"rewrapped_share_hex"`
		RewrappedHPKEEncHex string `json:"rewrapped_hpke_enc_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	rec, err := s.store.GetGuardianRecovery(r.Context(), req.RecoveryID)
	if err != nil || rec.AgentID != req.AgentID || rec.ExpiresAtMs <= nowMs {
		writeAPIError(w, http.StatusForbidden, "CREDENTIAL_REJECTED", "recovery session invalid or expired")
		return
	}
	cfg, shares, err := s.store.GetGuardianSetup(r.Context(), req.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "INVALID_ID", "guardian setup missing")
		return
	}
	var target *store.GuardianShareCustody
	for i := range shares {
		if shares[i].ShareIndex == req.ShareIndex && shares[i].GuardianID == req.GuardianID {
			target = &shares[i]
			break
		}
	}
	if target == nil {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "guardian not registered for share")
		return
	}
	gPub, err := decodeHexFixed32(target.GuardianPubKeyHex)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	sigBytes, err := hex.DecodeString(req.SignatureHex)
	canonicalMsg := fmt.Sprintf(`{"agent_id":%q,"guardian_id":%q,"recovery_id":%q,"share_index":%d}`, req.AgentID, req.GuardianID, req.RecoveryID, req.ShareIndex)
	if err != nil || len(sigBytes) != ed25519.SignatureSize || !ed25519.Verify(ed25519.PublicKey(gPub[:]), []byte(canonicalMsg), sigBytes) {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "guardian Ed25519 approval signature invalid")
		return
	}
	if err := s.store.AddGuardianApproval(r.Context(), store.GuardianApproval{
		RecoveryID:          req.RecoveryID,
		ShareIndex:          req.ShareIndex,
		GuardianID:          req.GuardianID,
		SignatureHex:        strings.ToLower(req.SignatureHex),
		RewrappedShareHex:   req.RewrappedShareHex,
		RewrappedHPKEEncHex: req.RewrappedHPKEEncHex,
		ApprovedAtMs:        nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	apps, _ := s.store.ListGuardianApprovals(r.Context(), req.RecoveryID)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "recorded",
		"approved_count": len(apps),
		"threshold":      cfg.Threshold,
	})
}

func (s *Service) handleGuardianRecoverGet(w http.ResponseWriter, r *http.Request) {
	recoveryID := r.PathValue("recovery_id")
	nowMs := s.clock().UnixMilli()
	rec, err := s.store.GetGuardianRecovery(r.Context(), recoveryID)
	if err != nil || rec.ExpiresAtMs <= nowMs {
		writeAPIError(w, http.StatusNotFound, "CREDENTIAL_REJECTED", "recovery session not found or expired")
		return
	}
	cfg, custodyShares, err := s.store.GetGuardianSetup(r.Context(), rec.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "STORAGE_ERROR", "guardian setup missing")
		return
	}
	apps, err := s.store.ListGuardianApprovals(r.Context(), recoveryID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}

	// Server-enforced gating: NEVER return share ciphertexts until approvals >= threshold!
	if len(apps) < cfg.Threshold {
		writeJSON(w, http.StatusOK, map[string]any{
			"recovery_id":     recoveryID,
			"status":          "pending",
			"threshold":       cfg.Threshold,
			"approved_count":  len(apps),
			"approved_shares": []store.GuardianShareCustody{},
		})
		return
	}

	custodyByIdx := make(map[int]store.GuardianShareCustody, len(custodyShares))
	for _, cs := range custodyShares {
		custodyByIdx[cs.ShareIndex] = cs
	}
	released := make([]store.GuardianShareCustody, 0, cfg.Threshold)
	for _, a := range apps {
		if cs, ok := custodyByIdx[a.ShareIndex]; ok {
			if a.RewrappedShareHex != "" {
				cs.EncryptedShareHex = a.RewrappedShareHex
				cs.HPKEEncHex = a.RewrappedHPKEEncHex
			}
			released = append(released, cs)
			if len(released) == cfg.Threshold {
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recovery_id":           recoveryID,
		"status":                "approved",
		"threshold":             cfg.Threshold,
		"approved_count":        len(apps),
		"commitment_blake3_hex": cfg.CommitmentBlake3Hex,
		"approved_shares":       released,
	})
}

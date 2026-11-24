// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/mlkem"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"

	"quetzalcoatl-hub/internal/store"
)

const (
	slot5KDFInfo       = "Quetzalcoatl-Slot5-HardwareSecret-v1"
	oidcChallengeTTLMs = 10 * 60 * 1000
)

func WrapWithHardwareSecret(agentID string, rootSecret [32]byte, hwSecret [32]byte) (*store.KeySlotEnvelope, error) {
	kek, err := deriveHKDF256Key(hwSecret[:], slot5KDFInfo)
	if err != nil {
		return nil, err
	}
	defer clear(kek[:])
	return wrapSymmetricSlot(agentID, "hardware_local", rootSecret, kek)
}

func UnwrapWithHardwareSecret(agentID string, hwSecret [32]byte, slot *store.KeySlotEnvelope) ([32]byte, error) {
	kek, err := deriveHKDF256Key(hwSecret[:], slot5KDFInfo)
	if err != nil {
		return [32]byte{}, err
	}
	defer clear(kek[:])
	return unwrapSymmetricSlot(agentID, "hardware_local", kek, slot)
}

type oidcPKCEChallengePayload struct {
	State         string `json:"state"`
	Nonce         string `json:"nonce"`
	CodeChallenge string `json:"code_challenge"`
}

func (s *Service) handleOIDCBegin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CodeChallenge       string `json:"code_challenge"`
		CodeChallengeMethod string `json:"code_challenge_method"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if req.CodeChallenge == "" || req.CodeChallengeMethod != "S256" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "PKCE S256 code_challenge required")
		return
	}
	chalID, _ := randomIDHex(16)
	state, _ := randomIDHex(16)
	nonce, _ := randomIDHex(16)
	payloadJSON, _ := json.Marshal(oidcPKCEChallengePayload{
		State:         state,
		Nonce:         nonce,
		CodeChallenge: req.CodeChallenge,
	})
	nowMs := s.clock().UnixMilli()
	if err := s.store.SaveChallenge(r.Context(), store.AuthChallenge{
		ChallengeID:       chalID,
		Purpose:           "oidc_pkce",
		ChallengeBytesHex: nonce,
		PayloadJSON:       string(payloadJSON),
		ExpiresAtMs:       nowMs + oidcChallengeTTLMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"challenge_id": chalID,
		"state":        state,
		"nonce":        nonce,
	})
}

func verifySignedJWT(token string, keys map[string]any, expectedIss, expectedAud string, nowUnix int64) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed JWT")
	}
	hdrRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("invalid JWT header encoding")
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hdrRaw, &hdr); err != nil {
		return nil, errors.New("invalid JWT header JSON")
	}
	pubKey, ok := keys[hdr.Kid]
	if !ok {
		return nil, fmt.Errorf("unknown JWT kid %q", hdr.Kid)
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, errors.New("invalid JWT signature encoding")
	}
	signingInput := parts[0] + "." + parts[1]
	digest := sha256.Sum256([]byte(signingInput))

	switch hdr.Alg {
	case "ES256":
		ecPub, ok := pubKey.(*ecdsa.PublicKey)
		if !ok || len(sigBytes) != 64 {
			return nil, errors.New("invalid ES256 key or signature length")
		}
		rInt := new(big.Int).SetBytes(sigBytes[0:32])
		sInt := new(big.Int).SetBytes(sigBytes[32:64])
		if !ecdsa.Verify(ecPub, digest[:], rInt, sInt) {
			return nil, errors.New("ES256 JWT signature verification failed")
		}
	case "RS256":
		rsaPub, ok := pubKey.(*rsa.PublicKey)
		if !ok {
			return nil, errors.New("invalid RS256 key")
		}
		if err := rsa.VerifyPKCS1v15(rsaPub, crypto.SHA256, digest[:], sigBytes); err != nil {
			return nil, errors.New("RS256 JWT signature verification failed")
		}
	default:
		return nil, fmt.Errorf("unsupported JWT alg %q", hdr.Alg)
	}

	claimsRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("invalid JWT claims encoding")
	}
	var claims map[string]any
	if err := json.Unmarshal(claimsRaw, &claims); err != nil {
		return nil, errors.New("invalid JWT claims JSON")
	}
	iss, _ := claims["iss"].(string)
	if expectedIss != "" && iss != expectedIss {
		return nil, fmt.Errorf("JWT issuer mismatch: %q", iss)
	}
	if expectedAud != "" {
		audOK := false
		switch aud := claims["aud"].(type) {
		case string:
			audOK = aud == expectedAud
		case []any:
			for _, item := range aud {
				if s, ok := item.(string); ok && s == expectedAud {
					audOK = true
					break
				}
			}
		}
		if !audOK {
			return nil, errors.New("JWT audience mismatch")
		}
	}
	if expFloat, ok := claims["exp"].(float64); ok {
		if int64(expFloat) <= nowUnix {
			return nil, errors.New("JWT expired")
		}
	}
	return claims, nil
}

func (s *Service) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChallengeID          string `json:"challenge_id"`
		State                string `json:"state"`
		CodeVerifier         string `json:"code_verifier"`
		IDToken              string `json:"id_token"`
		AgentID              string `json:"agent_id"`
		DeviceID             string `json:"device_id"`
		RootVerifyingKeyHex  string `json:"root_verifying_key_hex"`
		DeviceEd25519PubHex  string `json:"device_ed25519_pubkey_hex"`
		DeviceXWingPubKeyHex string `json:"device_xwing_pubkey_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	now := s.clock()
	nowMs := now.UnixMilli()
	ch, err := s.store.ConsumeChallenge(r.Context(), req.ChallengeID, "oidc_pkce", nowMs)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "OIDC challenge invalid or expired")
		return
	}
	var pkce oidcPKCEChallengePayload
	_ = json.Unmarshal([]byte(ch.PayloadJSON), &pkce)
	if req.State != pkce.State {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "OIDC state mismatch")
		return
	}
	verHash := sha256.Sum256([]byte(req.CodeVerifier))
	computedChallenge := base64.RawURLEncoding.EncodeToString(verHash[:])
	if subtle.ConstantTimeCompare([]byte(computedChallenge), []byte(pkce.CodeChallenge)) != 1 {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "PKCE code_verifier mismatch")
		return
	}

	claims, err := verifySignedJWT(req.IDToken, s.cfg.OIDCPublicKeys, s.cfg.OIDCIssuer, s.cfg.OIDCClientID, now.Unix())
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	if nonce, _ := claims["nonce"].(string); nonce != pkce.Nonce {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "OIDC ID token nonce mismatch")
		return
	}
	sub, _ := claims["sub"].(string)
	iss, _ := claims["iss"].(string)
	if sub == "" || iss == "" {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "OIDC sub/iss missing")
		return
	}

	acc, err := s.store.GetAccountByOIDC(r.Context(), iss, sub)
	if errors.Is(err, store.ErrNotFound) {
		accID, err := randomUUIDv4()
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
			return
		}
		acc = &store.Account{
			AccountID:   accID,
			OIDCIssuer:  iss,
			OIDCSubject: sub,
			CreatedAtMs: nowMs,
		}
		if err := s.store.CreateAccount(r.Context(), *acc); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
			return
		}
	} else if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}

	if req.AgentID != "" {
		if _, err := s.store.GetAgent(r.Context(), req.AgentID); errors.Is(err, store.ErrNotFound) {
			if _, err := decodeHexFixed32(req.RootVerifyingKeyHex); err != nil {
				writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid root_verifying_key_hex")
				return
			}
			if _, err := decodeHexFixed32(req.DeviceEd25519PubHex); err != nil {
				writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid device_ed25519_pubkey_hex")
				return
			}
			xwBytes, err := hex.DecodeString(req.DeviceXWingPubKeyHex)
			if err != nil || len(xwBytes) != XWingPKLen {
				writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid device_xwing_pubkey_hex")
				return
			}
			if _, err := mlkem.NewEncapsulationKey768(xwBytes[0:1184]); err != nil {
				writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid ML-KEM-768 key")
				return
			}
			if err := s.store.CreateAgent(r.Context(), store.Agent{
				AgentID:             req.AgentID,
				OwnerAccountID:      acc.AccountID,
				RootVerifyingKeyHex: strings.ToLower(req.RootVerifyingKeyHex),
				QuotaBytes:          s.cfg.DefaultAgentQuotaBytes,
				CreatedAtMs:         nowMs,
			}); err != nil {
				writeAPIError(w, http.StatusConflict, "STORAGE_ERROR", err.Error())
				return
			}
			if err := s.store.UpsertDevice(r.Context(), store.Device{
				AgentID:          req.AgentID,
				DeviceID:         req.DeviceID,
				AccountID:        acc.AccountID,
				Ed25519PubKeyHex: strings.ToLower(req.DeviceEd25519PubHex),
				XWingPubKeyHex:   strings.ToLower(req.DeviceXWingPubKeyHex),
				CreatedAtMs:      nowMs,
			}); err != nil {
				writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
				return
			}
		} else if ag, err := s.store.GetAgent(r.Context(), req.AgentID); err == nil && ag.OwnerAccountID != acc.AccountID {
			writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "agent owned by another account")
			return
		}
	}

	token, err := s.issueSession(r.Context(), acc.AccountID, req.AgentID, req.DeviceID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_token": token,
		"account_id":    acc.AccountID,
		"agent_id":      req.AgentID,
		"device_id":     req.DeviceID,
	})
}

func (s *Service) handleAuthEventsWebhook(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	rawBody, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	var setToken string
	trimmed := strings.TrimSpace(string(rawBody))
	if strings.HasPrefix(trimmed, "{") {
		var body struct {
			SETToken string `json:"set_token"`
		}
		if err := json.Unmarshal(rawBody, &body); err != nil {
			writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
			return
		}
		setToken = body.SETToken
	} else {
		setToken = trimmed
	}

	// Strictly enforce ES256 for account deletion Security Event Token webhook
	parts := strings.Split(setToken, ".")
	if len(parts) != 3 {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "malformed SET JWT")
		return
	}
	hdrBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !strings.Contains(string(hdrBytes), `"ES256"`) {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "ES256 SET signature required")
		return
	}
	claims, err := verifySignedJWT(setToken, s.cfg.WebhookPublicKeys, s.cfg.OIDCIssuer, s.cfg.OIDCClientID, s.clock().Unix())
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	events, ok := claims["events"].(map[string]any)
	if !ok || len(events) == 0 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "missing SET events claim")
		return
	}
	isDelete := false
	for k := range events {
		if strings.Contains(k, "account-purged") || strings.Contains(k, "account-disabled") || k == "account.deleted" {
			isDelete = true
			break
		}
	}
	if !isDelete {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored"})
		return
	}
	iss, _ := claims["iss"].(string)
	sub, _ := claims["sub"].(string)
	if iss == "" || sub == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "missing SET iss/sub")
		return
	}
	blobKeys, err := s.store.DeleteAccountByOIDC(r.Context(), iss, sub)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if s.blobs != nil && len(blobKeys) > 0 {
		_ = s.blobs.DeleteBlobs(r.Context(), blobKeys)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Service) handlePutHardwareSlot(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	var req struct {
		AADUTF8       string `json:"aad_utf8"`
		NonceHex      string `json:"nonce_hex"`
		CiphertextHex string `json:"ciphertext_hex"`
		MetadataJSON  string `json:"metadata_json"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if err := validateSymmetricSlotEnvelope(agentID, "hardware_local", req.AADUTF8, req.NonceHex, req.CiphertextHex); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	if req.MetadataJSON != "" {
		var js map[string]any
		if err := json.Unmarshal([]byte(req.MetadataJSON), &js); err != nil {
			writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", "invalid metadata_json")
			return
		}
	}
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       agentID,
		Slot:          "hardware_local",
		AADUTF8:       req.AADUTF8,
		NonceHex:      strings.ToLower(req.NonceHex),
		CiphertextHex: strings.ToLower(req.CiphertextHex),
		MetadataJSON:  req.MetadataJSON,
		UpdatedAtMs:   s.clock().UnixMilli(),
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	slots, err := s.store.ListKeySlots(r.Context(), agentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slots": slots})
}

func (s *Service) handleListSlots(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	slots, err := s.store.ListKeySlots(r.Context(), agentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"slots": slots})
}

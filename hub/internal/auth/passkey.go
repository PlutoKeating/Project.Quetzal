// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/mlkem"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gtank/ristretto255"
	"golang.org/x/crypto/chacha20poly1305"
	"quetzalcoatl-hub/internal/store"
)

var ErrNotImplemented = errors.New("not implemented")

const (
	passkeyChallengeTTLMs = 5 * 60 * 1000
	sessionTTLMs          = 30 * 24 * 60 * 60 * 1000
	slot1KDFInfo          = "Quetzalcoatl-Slot1-PasskeyPRF-v1"
)

type Config struct {
	RPID string
	// PublicURL 是 Hub 自身对外可达的基址，仅用于向已授权设备广播 iroh Relay 地址。
	PublicURL                 string
	AllowedOrigins            []string
	ServerIdentity            string
	OPRFMasterSeed            [32]byte
	ServerOpaquePrivateScalar [32]byte
	PairingHMACSecret         [32]byte
	DefaultAgentQuotaBytes    int64
	OIDCIssuer                string
	OIDCClientID              string
	OIDCPublicKeys            map[string]any
	WebhookPublicKeys         map[string]any
}

type Principal struct {
	AccountID string
	AgentID   string
	DeviceID  string
}

type Service struct {
	store              store.Store
	blobs              store.BlobStore
	cfg                Config
	clock              func() time.Time
	serverOpaqueScalar *ristretto255.Scalar
	serverOpaquePubKey [32]byte
}

func NewService(st store.Store, blobs store.BlobStore, cfg Config, clock func() time.Time) (*Service, error) {
	if st == nil {
		return nil, errors.New("store is required")
	}
	if clock == nil {
		clock = time.Now
	}
	if cfg.RPID == "" {
		cfg.RPID = "localhost"
	}
	cfg.PublicURL = strings.TrimRight(strings.TrimSpace(cfg.PublicURL), "/")
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = []string{"http://localhost", "https://" + cfg.RPID}
	}
	if cfg.ServerIdentity == "" {
		cfg.ServerIdentity = "server:quetzalcoatl-hub:v2"
	}
	if cfg.DefaultAgentQuotaBytes <= 0 {
		cfg.DefaultAgentQuotaBytes = 1024 * 1024 * 1024 // 1 GiB default
	}

	var serverScalar *ristretto255.Scalar
	var serverPub [32]byte
	var zero32 [32]byte
	if cfg.ServerOpaquePrivateScalar == zero32 {
		sc, _, err := generateRandomRistrettoScalar()
		if err != nil {
			return nil, err
		}
		serverScalar = sc
	} else {
		sc, err := decodeCanonicalRistrettoScalar("ServerOpaquePrivateScalar", cfg.ServerOpaquePrivateScalar)
		if err != nil {
			return nil, err
		}
		serverScalar = sc
	}
	copy(serverPub[:], ristretto255.NewIdentityElement().ScalarBaseMult(serverScalar).Bytes())

	return &Service{
		store:              st,
		blobs:              blobs,
		cfg:                cfg,
		clock:              clock,
		serverOpaqueScalar: serverScalar,
		serverOpaquePubKey: serverPub,
	}, nil
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/auth/passkey/register/begin", s.handlePasskeyRegisterBegin)
	mux.HandleFunc("POST /v1/auth/passkey/register/finish", s.handlePasskeyRegisterFinish)
	mux.HandleFunc("POST /v1/auth/passkey/login/begin", s.handlePasskeyLoginBegin)
	mux.HandleFunc("POST /v1/auth/passkey/login/finish", s.handlePasskeyLoginFinish)

	mux.HandleFunc("POST /v1/pair/initiate", s.handlePairInitiate)
	mux.HandleFunc("POST /v1/pair/join", s.handlePairJoin)
	mux.HandleFunc("GET /v1/pair/{pairing_id}", s.handlePairGet)
	mux.HandleFunc("POST /v1/pair/approve", s.handlePairApprove)
	mux.HandleFunc("POST /v1/pair/complete", s.handlePairComplete)

	mux.HandleFunc("POST /v1/auth/guardian/setup", s.handleGuardianSetup)
	mux.HandleFunc("POST /v1/auth/guardian/recover/request", s.handleGuardianRecoverRequest)
	mux.HandleFunc("POST /v1/auth/guardian/recover/approve", s.handleGuardianRecoverApprove)
	mux.HandleFunc("GET /v1/auth/guardian/recover/{recovery_id}", s.handleGuardianRecoverGet)

	mux.HandleFunc("POST /v1/auth/opaque/register/init", s.handleOpaqueRegisterInit)
	mux.HandleFunc("POST /v1/auth/opaque/register/finish", s.handleOpaqueRegisterFinish)
	mux.HandleFunc("POST /v1/auth/opaque/login/start", s.handleOpaqueLoginStart)
	mux.HandleFunc("POST /v1/auth/opaque/login/finish", s.handleOpaqueLoginFinish)

	mux.HandleFunc("POST /v1/auth/oidc/begin", s.handleOIDCBegin)
	mux.HandleFunc("POST /v1/auth/oidc/callback", s.handleOIDCCallback)
	mux.HandleFunc("POST /v1/auth/events", s.handleAuthEventsWebhook)
	mux.HandleFunc("PUT /v1/auth/slots/{agent_id}/hardware_local", s.handlePutHardwareSlot)
	mux.HandleFunc("GET /v1/auth/slots/{agent_id}", s.handleListSlots)
	mux.HandleFunc("POST /v1/auth/devices", s.handleAddDevice)
	mux.HandleFunc("GET /v1/auth/devices/{agent_id}", s.handleListDevices)
}

// RequireAuth authenticates a Bearer session token and rejects unauthenticated (401) or revoked-device (403) callers.
func (s *Service) RequireAuth(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	return s.requireAuth(w, r)
}

// RequireAgentOwner authenticates Bearer token and enforces strict resource ownership (HTTP 403 Forbidden on cross-account access).
func (s *Service) RequireAgentOwner(w http.ResponseWriter, r *http.Request, agentID string) (*Principal, *store.Agent, bool) {
	return s.requireAgentOwner(w, r, agentID)
}

func (s *Service) requireAuth(w http.ResponseWriter, r *http.Request) (*Principal, bool) {
	hdr := r.Header.Get("Authorization")
	if !strings.HasPrefix(hdr, "Bearer ") {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "missing Bearer token")
		return nil, false
	}
	rawToken := strings.TrimSpace(strings.TrimPrefix(hdr, "Bearer "))
	if rawToken == "" {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "empty Bearer token")
		return nil, false
	}
	sum := sha256.Sum256([]byte(rawToken))
	sess, err := s.store.GetSession(r.Context(), hex.EncodeToString(sum[:]))
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "invalid session token")
		return nil, false
	}
	if sess.ExpiresAtMs <= s.clock().UnixMilli() {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "expired session token")
		return nil, false
	}
	if sess.AgentID != "" && sess.DeviceID != "" {
		dev, err := s.store.GetDevice(r.Context(), sess.AgentID, sess.DeviceID)
		if err != nil || dev.Revoked {
			writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "device revoked")
			return nil, false
		}
	}
	return &Principal{
		AccountID: sess.AccountID,
		AgentID:   sess.AgentID,
		DeviceID:  sess.DeviceID,
	}, true
}

func (s *Service) requireAgentOwner(w http.ResponseWriter, r *http.Request, agentID string) (*Principal, *store.Agent, bool) {
	principal, ok := s.requireAuth(w, r)
	if !ok {
		return nil, nil, false
	}
	if agentID == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "missing agent_id")
		return nil, nil, false
	}
	ag, err := s.store.GetAgent(r.Context(), agentID)
	if err != nil {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "agent access denied")
		return nil, nil, false
	}
	if ag.OwnerAccountID != principal.AccountID {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "account does not own target agent")
		return nil, nil, false
	}
	return principal, ag, true
}

func (s *Service) issueSession(ctx context.Context, accountID, agentID, deviceID string) (string, error) {
	rawToken, err := randomIDHex(32)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(rawToken))
	nowMs := s.clock().UnixMilli()
	if err := s.store.CreateSession(ctx, store.Session{
		TokenSHA256Hex: hex.EncodeToString(sum[:]),
		AccountID:      accountID,
		AgentID:        agentID,
		DeviceID:       deviceID,
		ExpiresAtMs:    nowMs + sessionTTLMs,
		CreatedAtMs:    nowMs,
	}); err != nil {
		return "", err
	}
	return rawToken, nil
}

func canonicalSlotAAD(agentID, slot string) string {
	return fmt.Sprintf(`{"agent_id":"%s","slot":"%s","v":2}`, agentID, slot)
}

func deriveHKDF256Key(ikm []byte, info string) ([32]byte, error) {
	var out [32]byte
	k, err := hkdf.Key(sha256.New, ikm, nil, info, 32)
	if err != nil {
		return out, err
	}
	copy(out[:], k)
	return out, nil
}

func wrapSymmetricSlot(agentID, slot string, rootSecret, kek [32]byte) (*store.KeySlotEnvelope, error) {
	aad := canonicalSlotAAD(agentID, slot)
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(kek[:])
	if err != nil {
		return nil, err
	}
	ct := aead.Seal(nil, nonce[:], rootSecret[:], []byte(aad))
	return &store.KeySlotEnvelope{
		AgentID:       agentID,
		Slot:          slot,
		AADUTF8:       aad,
		NonceHex:      hex.EncodeToString(nonce[:]),
		CiphertextHex: hex.EncodeToString(ct),
	}, nil
}

func unwrapSymmetricSlot(agentID, expectedSlot string, kek [32]byte, slot *store.KeySlotEnvelope) ([32]byte, error) {
	var out [32]byte
	expectedAAD := canonicalSlotAAD(agentID, expectedSlot)
	if slot.Slot != expectedSlot || slot.AADUTF8 != expectedAAD {
		return out, errors.New("INTEGRITY_VIOLATION: slot AAD or type mismatch")
	}
	nonce, err := hex.DecodeString(slot.NonceHex)
	if err != nil || len(nonce) != 24 {
		return out, errors.New("INTEGRITY_VIOLATION: invalid slot nonce")
	}
	ct, err := hex.DecodeString(slot.CiphertextHex)
	if err != nil {
		return out, errors.New("INTEGRITY_VIOLATION: invalid slot ciphertext")
	}
	aead, err := chacha20poly1305.NewX(kek[:])
	if err != nil {
		return out, err
	}
	plain, err := aead.Open(nil, nonce, ct, []byte(slot.AADUTF8))
	if err != nil {
		return out, errors.New("INTEGRITY_VIOLATION: slot decryption failed")
	}
	defer clear(plain)
	if len(plain) != 32 {
		return out, errors.New("INTEGRITY_VIOLATION: unwrapped root key length != 32")
	}
	copy(out[:], plain)
	return out, nil
}

func validateSymmetricSlotEnvelope(agentID, slotType, aadUTF8, nonceHex, ctHex string) error {
	if aadUTF8 != canonicalSlotAAD(agentID, slotType) {
		return fmt.Errorf("AAD mismatch for slot %s", slotType)
	}
	nonce, err := hex.DecodeString(nonceHex)
	if err != nil || len(nonce) != 24 {
		return errors.New("nonce must be 24 bytes")
	}
	ct, err := hex.DecodeString(ctHex)
	if err != nil || len(ct) != 48 { // 32B AccountRootKey + 16B Poly1305 tag
		return errors.New("ciphertext must be 48 bytes (AEAD wrapped 32B key)")
	}
	return nil
}

func WrapWithPasskeyPRF(agentID string, rootSecret [32]byte, prfOutput [32]byte) (*store.KeySlotEnvelope, error) {
	kek, err := deriveHKDF256Key(prfOutput[:], slot1KDFInfo)
	if err != nil {
		return nil, err
	}
	defer clear(kek[:])
	return wrapSymmetricSlot(agentID, "passkey_prf", rootSecret, kek)
}

func UnwrapWithPasskeyPRF(agentID string, prfOutput [32]byte, slot *store.KeySlotEnvelope) ([32]byte, error) {
	kek, err := deriveHKDF256Key(prfOutput[:], slot1KDFInfo)
	if err != nil {
		return [32]byte{}, err
	}
	defer clear(kek[:])
	return unwrapSymmetricSlot(agentID, "passkey_prf", kek, slot)
}

type passkeyRegChallengePayload struct {
	AgentID          string `json:"agent_id"`
	DeviceID         string `json:"device_id"`
	RootVKHex        string `json:"root_verifying_key_hex"`
	DeviceEd25519Hex string `json:"device_ed25519_pubkey_hex"`
	DeviceXWingHex   string `json:"device_xwing_pubkey_hex"`
	PRFSaltHex       string `json:"prf_salt_hex"`
}

func (s *Service) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var req struct {
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
	if req.AgentID == "" || req.DeviceID == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "agent_id and device_id required")
		return
	}
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
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "device_xwing_pubkey_hex must be 1216 bytes")
		return
	}
	if _, err := mlkem.NewEncapsulationKey768(xwBytes[0:1184]); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid ML-KEM-768 key")
		return
	}

	var chalBytes, prfSalt [32]byte
	_, _ = rand.Read(chalBytes[:])
	_, _ = rand.Read(prfSalt[:])
	chalID, _ := randomIDHex(16)
	payloadBytes, _ := json.Marshal(passkeyRegChallengePayload{
		AgentID:          req.AgentID,
		DeviceID:         req.DeviceID,
		RootVKHex:        strings.ToLower(req.RootVerifyingKeyHex),
		DeviceEd25519Hex: strings.ToLower(req.DeviceEd25519PubHex),
		DeviceXWingHex:   strings.ToLower(req.DeviceXWingPubKeyHex),
		PRFSaltHex:       hex.EncodeToString(prfSalt[:]),
	})
	nowMs := s.clock().UnixMilli()
	if err := s.store.SaveChallenge(r.Context(), store.AuthChallenge{
		ChallengeID:       chalID,
		Purpose:           "passkey_register",
		ChallengeBytesHex: hex.EncodeToString(chalBytes[:]),
		AgentID:           req.AgentID,
		PayloadJSON:       string(payloadBytes),
		ExpiresAtMs:       nowMs + passkeyChallengeTTLMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge_id":  chalID,
		"challenge_b64": base64.RawURLEncoding.EncodeToString(chalBytes[:]),
		"rp_id":         s.cfg.RPID,
		"rp_name":       "Quetzalcoatl",
		"prf_salt_hex":  hex.EncodeToString(prfSalt[:]),
	})
}

func (s *Service) verifyWebAuthnAssertion(
	expectedType string,
	expectedChallengeHex string,
	alg int,
	pubKeyHex string,
	clientDataB64 string,
	authDataB64 string,
	sigB64 string,
) (uint32, error) {
	clientDataRaw, err := base64.RawURLEncoding.DecodeString(clientDataB64)
	if err != nil {
		return 0, errors.New("invalid client_data_json_b64")
	}
	var cd struct {
		Type        string `json:"type"`
		Challenge   string `json:"challenge"`
		Origin      string `json:"origin"`
		CrossOrigin bool   `json:"crossOrigin"`
	}
	if err := json.Unmarshal(clientDataRaw, &cd); err != nil {
		return 0, errors.New("malformed clientDataJSON")
	}
	if cd.Type != expectedType || cd.CrossOrigin {
		return 0, errors.New("invalid WebAuthn ceremony type or crossOrigin")
	}
	if !slices.Contains(s.cfg.AllowedOrigins, cd.Origin) {
		return 0, fmt.Errorf("disallowed WebAuthn origin %q", cd.Origin)
	}
	chalBytes, _ := hex.DecodeString(expectedChallengeHex)
	if cd.Challenge != base64.RawURLEncoding.EncodeToString(chalBytes) {
		return 0, errors.New("WebAuthn challenge mismatch")
	}

	authData, err := base64.RawURLEncoding.DecodeString(authDataB64)
	if err != nil || len(authData) < 37 {
		return 0, errors.New("invalid authenticatorData")
	}
	rpHash := sha256.Sum256([]byte(s.cfg.RPID))
	if string(authData[0:32]) != string(rpHash[:]) {
		return 0, errors.New("WebAuthn RP ID hash mismatch")
	}
	if (authData[32] & 0x01) == 0 {
		return 0, errors.New("WebAuthn User Present (UP) flag missing")
	}
	signCount := binary.BigEndian.Uint32(authData[33:37])

	sigBytes, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return 0, errors.New("invalid signature_b64")
	}
	pubBytes, err := hex.DecodeString(pubKeyHex)
	if err != nil {
		return 0, errors.New("invalid public_key_hex")
	}
	cdHash := sha256.Sum256(clientDataRaw)
	signedPayload := append(append([]byte(nil), authData...), cdHash[:]...)

	switch alg {
	case -7: // ES256 (P-256)
		// Go 1.26 parse uncompressed SEC1 P-256 point via crypto/ecdh -> ecdsa.PublicKey
		ecdhPub, err := ecdh.P256().NewPublicKey(pubBytes)
		if err != nil {
			return 0, errors.New("invalid ES256 P-256 public key")
		}
		rawPt := ecdhPub.Bytes() // 65 bytes: 0x04 || X(32) || Y(32) validated on P-256
		ecPub := &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(rawPt[1:33]),
			Y:     new(big.Int).SetBytes(rawPt[33:65]),
		}
		digest := sha256.Sum256(signedPayload)
		if !ecdsa.VerifyASN1(ecPub, digest[:], sigBytes) {
			return 0, errors.New("ES256 WebAuthn signature verification failed")
		}
	case -8: // EdDSA (Ed25519)
		if len(pubBytes) != ed25519.PublicKeySize || len(sigBytes) != ed25519.SignatureSize {
			return 0, errors.New("invalid EdDSA key/signature length")
		}
		if !ed25519.Verify(ed25519.PublicKey(pubBytes), signedPayload, sigBytes) {
			return 0, errors.New("EdDSA WebAuthn signature verification failed")
		}
	default:
		return 0, fmt.Errorf("unsupported COSE alg %d", alg)
	}
	return signCount, nil
}

func (s *Service) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChallengeID          string                `json:"challenge_id"`
		CredentialID         string                `json:"credential_id"`
		Alg                  int                   `json:"alg"`
		PublicKeyHex         string                `json:"public_key_hex"`
		ClientDataJSONB64    string                `json:"client_data_json_b64"`
		AuthenticatorDataB64 string                `json:"authenticator_data_b64"`
		SignatureB64         string                `json:"signature_b64"`
		Slot1Envelope        store.KeySlotEnvelope `json:"slot1_envelope"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	ch, err := s.store.ConsumeChallenge(r.Context(), req.ChallengeID, "passkey_register", nowMs)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "challenge invalid, consumed, or expired")
		return
	}
	var payload passkeyRegChallengePayload
	if err := json.Unmarshal([]byte(ch.PayloadJSON), &payload); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	signCount, err := s.verifyWebAuthnAssertion(
		"webauthn.create",
		ch.ChallengeBytesHex,
		req.Alg,
		req.PublicKeyHex,
		req.ClientDataJSONB64,
		req.AuthenticatorDataB64,
		req.SignatureB64,
	)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	if err := validateSymmetricSlotEnvelope(payload.AgentID, "passkey_prf", req.Slot1Envelope.AADUTF8, req.Slot1Envelope.NonceHex, req.Slot1Envelope.CiphertextHex); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}

	accountID, err := randomUUIDv4()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.CreateAccount(r.Context(), store.Account{
		AccountID:   accountID,
		CreatedAtMs: nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.CreateAgent(r.Context(), store.Agent{
		AgentID:             payload.AgentID,
		OwnerAccountID:      accountID,
		RootVerifyingKeyHex: payload.RootVKHex,
		QuotaBytes:          s.cfg.DefaultAgentQuotaBytes,
		CreatedAtMs:         nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusConflict, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.UpsertDevice(r.Context(), store.Device{
		AgentID:          payload.AgentID,
		DeviceID:         payload.DeviceID,
		AccountID:        accountID,
		Ed25519PubKeyHex: payload.DeviceEd25519Hex,
		XWingPubKeyHex:   payload.DeviceXWingHex,
		CreatedAtMs:      nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.SavePasskeyCredential(r.Context(), store.PasskeyCredential{
		CredentialID: req.CredentialID,
		AccountID:    accountID,
		AgentID:      payload.AgentID,
		Alg:          req.Alg,
		PublicKeyHex: strings.ToLower(req.PublicKeyHex),
		SignCount:    signCount,
		PRFSaltHex:   payload.PRFSaltHex,
		CreatedAtMs:  nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusConflict, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       payload.AgentID,
		Slot:          "passkey_prf",
		AADUTF8:       req.Slot1Envelope.AADUTF8,
		NonceHex:      strings.ToLower(req.Slot1Envelope.NonceHex),
		CiphertextHex: strings.ToLower(req.Slot1Envelope.CiphertextHex),
		UpdatedAtMs:   nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	token, err := s.issueSession(r.Context(), accountID, payload.AgentID, payload.DeviceID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_token": token,
		"account_id":    accountID,
		"agent_id":      payload.AgentID,
		"device_id":     payload.DeviceID,
		"prf_salt_hex":  payload.PRFSaltHex,
	})
}

func (s *Service) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID string `json:"agent_id"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	creds, err := s.store.ListPasskeyCredentialsByAgent(r.Context(), req.AgentID)
	if err != nil || len(creds) == 0 {
		writeAPIError(w, http.StatusNotFound, "CREDENTIAL_REJECTED", "no passkey credentials for agent")
		return
	}
	var chalBytes [32]byte
	_, _ = rand.Read(chalBytes[:])
	chalID, _ := randomIDHex(16)
	nowMs := s.clock().UnixMilli()
	if err := s.store.SaveChallenge(r.Context(), store.AuthChallenge{
		ChallengeID:       chalID,
		Purpose:           "passkey_login",
		ChallengeBytesHex: hex.EncodeToString(chalBytes[:]),
		AgentID:           req.AgentID,
		ExpiresAtMs:       nowMs + passkeyChallengeTTLMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	allow := make([]string, 0, len(creds))
	for _, c := range creds {
		allow = append(allow, c.CredentialID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge_id":      chalID,
		"challenge_b64":     base64.RawURLEncoding.EncodeToString(chalBytes[:]),
		"rp_id":             s.cfg.RPID,
		"allow_credentials": allow,
		"prf_salt_hex":      creds[0].PRFSaltHex,
	})
}

func (s *Service) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChallengeID          string `json:"challenge_id"`
		CredentialID         string `json:"credential_id"`
		DeviceID             string `json:"device_id"`
		ClientDataJSONB64    string `json:"client_data_json_b64"`
		AuthenticatorDataB64 string `json:"authenticator_data_b64"`
		SignatureB64         string `json:"signature_b64"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	ch, err := s.store.ConsumeChallenge(r.Context(), req.ChallengeID, "passkey_login", nowMs)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "challenge invalid or expired")
		return
	}
	cred, err := s.store.GetPasskeyCredential(r.Context(), req.CredentialID)
	if err != nil || cred.AgentID != ch.AgentID {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "credential mismatch")
		return
	}
	signCount, err := s.verifyWebAuthnAssertion(
		"webauthn.get",
		ch.ChallengeBytesHex,
		cred.Alg,
		cred.PublicKeyHex,
		req.ClientDataJSONB64,
		req.AuthenticatorDataB64,
		req.SignatureB64,
	)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	if req.DeviceID != "" {
		dev, devErr := s.store.GetDevice(r.Context(), cred.AgentID, req.DeviceID)
		if devErr != nil || dev.Revoked {
			writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "device is unregistered or revoked")
			return
		}
	}
	if cred.SignCount > 0 && signCount > 0 && signCount <= cred.SignCount {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "cloned authenticator signCount detected")
		return
	}
	if signCount > cred.SignCount {
		_ = s.store.UpdatePasskeySignCount(r.Context(), cred.CredentialID, signCount)
	}
	slot1, err := s.store.GetKeySlot(r.Context(), cred.AgentID, "passkey_prf")
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "STORAGE_ERROR", "slot1 missing")
		return
	}
	token, err := s.issueSession(r.Context(), cred.AccountID, cred.AgentID, req.DeviceID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_token":  token,
		"account_id":     cred.AccountID,
		"agent_id":       cred.AgentID,
		"slot1_envelope": slot1,
	})
}

func decodeJSONBody(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	return dec.Decode(dst)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeAPIError(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, map[string]any{
		"code":   code,
		"detail": detail,
	})
}

func decodeHexFixed32(s string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 {
		return out, errors.New("expected 32-byte hex")
	}
	copy(out[:], b)
	return out, nil
}

func randomIDHex(numBytes int) (string, error) {
	b := make([]byte, numBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func randomUUIDv4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

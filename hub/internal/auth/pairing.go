// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/mlkem"
	"crypto/mlkem/mlkemtest"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha3"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"golang.org/x/crypto/chacha20poly1305"
	"lukechampine.com/blake3"
	"quetzalcoatl-hub/internal/store"
)

const (
	XWingPKLen         = 1216
	XWingEncLen        = 1120
	XWingCombinerLabel = `\.//^\`

	EpochKeyWrapInfo   = "quetzalcoatl/v2/epoch-key-wrap"
	WebhookIngressInfo = "quetzalcoatl/v2/webhook-ingress"
	PairingWrapInfo    = "quetzalcoatl/v2/pairing-root-wrap"

	membershipDomainContext = "quetzalcoatl/v2/root-membership-v1"
	pairingTTLMs            = 5 * 60 * 1000
	pairingMaxAttempts      = 5
)

var hpkeSuiteIDXWing = []byte("HPKE\x64\x7a\x00\x01\x00\x03")

type XWingEncapDebug struct {
	Enc          [XWingEncLen]byte
	SharedSecret [32]byte
	MLKEM768SS   [32]byte
	X25519CT     [32]byte
	X25519SS     [32]byte
}

type XWingKeyPair struct {
	skSeed     [32]byte
	expanded96 [96]byte
	pkBytes    [XWingPKLen]byte
}

func xwingCombine(ssM, ssX, ctX, pkX [32]byte) [32]byte {
	h := sha3.New256()
	_, _ = h.Write(ssM[:])
	_, _ = h.Write(ssX[:])
	_, _ = h.Write(ctX[:])
	_, _ = h.Write(pkX[:])
	_, _ = h.Write([]byte(XWingCombinerLabel))
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func GenerateXWingKeyPair() (*XWingKeyPair, error) {
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return nil, err
	}
	return XWingFromSeed(seed)
}

func XWingFromSeed(skSeed [32]byte) (*XWingKeyPair, error) {
	expSlice := sha3.SumSHAKE256(skSeed[:], 96)
	var expanded96 [96]byte
	copy(expanded96[:], expSlice)

	dkM, err := mlkem.NewDecapsulationKey768(expanded96[0:64])
	if err != nil {
		return nil, fmt.Errorf("mlkem768 derive: %w", err)
	}
	ekMBytes := dkM.EncapsulationKey().Bytes()

	privX, err := ecdh.X25519().NewPrivateKey(expanded96[64:96])
	if err != nil {
		return nil, fmt.Errorf("x25519 derive: %w", err)
	}
	pubXBytes := privX.PublicKey().Bytes()

	var pkBytes [XWingPKLen]byte
	copy(pkBytes[0:1184], ekMBytes)
	copy(pkBytes[1184:1216], pubXBytes)
	return &XWingKeyPair{
		skSeed:     skSeed,
		expanded96: expanded96,
		pkBytes:    pkBytes,
	}, nil
}

func (kp *XWingKeyPair) ExpandedSHAKE256_96() [96]byte {
	return kp.expanded96
}

func (kp *XWingKeyPair) PublicKeyBytes() [XWingPKLen]byte {
	return kp.pkBytes
}

func (kp *XWingKeyPair) X25519PublicKeyBytes() [32]byte {
	var out [32]byte
	copy(out[:], kp.pkBytes[1184:1216])
	return out
}

func XWingEncapsulateDeterministic(pkBytes [XWingPKLen]byte, encapSeed64 [64]byte) (*XWingEncapDebug, error) {
	ekM, err := mlkem.NewEncapsulationKey768(pkBytes[0:1184])
	if err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: invalid ML-KEM-768 public key: %w", err)
	}
	ssMSlice, ctMSlice, err := mlkemtest.Encapsulate768(ekM, encapSeed64[0:32])
	if err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: ML-KEM-768 encapsulate failed: %w", err)
	}

	pkX, err := ecdh.X25519().NewPublicKey(pkBytes[1184:1216])
	if err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: invalid X25519 public key: %w", err)
	}
	ekX, err := ecdh.X25519().NewPrivateKey(encapSeed64[32:64])
	if err != nil {
		return nil, err
	}
	ssXSlice, err := ekX.ECDH(pkX)
	if err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: X25519 ECDH failed: %w", err)
	}

	var ssM, ctX, ssX, pkXArr [32]byte
	copy(ssM[:], ssMSlice)
	copy(ctX[:], ekX.PublicKey().Bytes())
	copy(ssX[:], ssXSlice)
	copy(pkXArr[:], pkBytes[1184:1216])

	ss := xwingCombine(ssM, ssX, ctX, pkXArr)
	var enc [XWingEncLen]byte
	copy(enc[0:1088], ctMSlice)
	copy(enc[1088:1120], ctX[:])

	return &XWingEncapDebug{
		Enc:          enc,
		SharedSecret: ss,
		MLKEM768SS:   ssM,
		X25519CT:     ctX,
		X25519SS:     ssX,
	}, nil
}

func XWingEncapsulate(pkBytes [XWingPKLen]byte) ([XWingEncLen]byte, [32]byte, error) {
	var seed64 [64]byte
	var zeroEnc [XWingEncLen]byte
	var zeroSS [32]byte
	if _, err := rand.Read(seed64[:]); err != nil {
		return zeroEnc, zeroSS, err
	}
	dbg, err := XWingEncapsulateDeterministic(pkBytes, seed64)
	clear(seed64[:])
	if err != nil {
		return zeroEnc, zeroSS, err
	}
	return dbg.Enc, dbg.SharedSecret, nil
}

func (kp *XWingKeyPair) Decapsulate(enc [XWingEncLen]byte) ([32]byte, error) {
	var zero [32]byte
	dkM, err := mlkem.NewDecapsulationKey768(kp.expanded96[0:64])
	if err != nil {
		return zero, err
	}
	ssMSlice, err := dkM.Decapsulate(enc[0:1088])
	if err != nil {
		return zero, fmt.Errorf("INTEGRITY_VIOLATION: ML-KEM-768 decapsulate failed: %w", err)
	}
	ctXPub, err := ecdh.X25519().NewPublicKey(enc[1088:1120])
	if err != nil {
		return zero, fmt.Errorf("INTEGRITY_VIOLATION: invalid X25519 ct: %w", err)
	}
	skX, err := ecdh.X25519().NewPrivateKey(kp.expanded96[64:96])
	if err != nil {
		return zero, err
	}
	ssXSlice, err := skX.ECDH(ctXPub)
	if err != nil {
		return zero, fmt.Errorf("INTEGRITY_VIOLATION: X25519 ECDH failed: %w", err)
	}

	var ssM, ssX, ctX [32]byte
	copy(ssM[:], ssMSlice)
	copy(ssX[:], ssXSlice)
	copy(ctX[:], enc[1088:1120])
	return xwingCombine(ssM, ssX, ctX, kp.X25519PublicKeyBytes()), nil
}

type HPKEBaseSchedule struct {
	AEADKey        [32]byte
	BaseNonce      [12]byte
	ExporterSecret [32]byte
}

type HPKESealedBox struct {
	Enc        []byte `json:"enc"`
	Ciphertext []byte `json:"ciphertext"`
}

func hpkeLabeledExtract(salt, label, ikm []byte) ([32]byte, error) {
	effSalt := salt
	if len(effSalt) == 0 {
		effSalt = make([]byte, 32)
	}
	mac := hmac.New(sha256.New, effSalt)
	_, _ = mac.Write([]byte("HPKE-v1"))
	_, _ = mac.Write(hpkeSuiteIDXWing)
	_, _ = mac.Write(label)
	_, _ = mac.Write(ikm)
	var out [32]byte
	copy(out[:], mac.Sum(nil))
	return out, nil
}

func hpkeLabeledExpand(prk [32]byte, label, info []byte, length int) ([]byte, error) {
	var lenB [2]byte
	binary.BigEndian.PutUint16(lenB[:], uint16(length))
	labeledInfo := make([]byte, 0, 2+7+len(hpkeSuiteIDXWing)+len(label)+len(info))
	labeledInfo = append(labeledInfo, lenB[:]...)
	labeledInfo = append(labeledInfo, "HPKE-v1"...)
	labeledInfo = append(labeledInfo, hpkeSuiteIDXWing...)
	labeledInfo = append(labeledInfo, label...)
	labeledInfo = append(labeledInfo, info...)
	return hkdf.Expand(sha256.New, prk[:], string(labeledInfo), length)
}

func HPKEKeyScheduleBase(sharedSecret [32]byte, info []byte) (*HPKEBaseSchedule, error) {
	pskIDHash, err := hpkeLabeledExtract(nil, []byte("psk_id_hash"), nil)
	if err != nil {
		return nil, err
	}
	infoHash, err := hpkeLabeledExtract(nil, []byte("info_hash"), info)
	if err != nil {
		return nil, err
	}
	var ksContext [65]byte
	ksContext[0] = 0x00 // mode_base
	copy(ksContext[1:33], pskIDHash[:])
	copy(ksContext[33:65], infoHash[:])

	secret, err := hpkeLabeledExtract(sharedSecret[:], []byte("secret"), nil)
	if err != nil {
		return nil, err
	}
	defer clear(secret[:])

	keySlice, err := hpkeLabeledExpand(secret, []byte("key"), ksContext[:], 32)
	if err != nil {
		return nil, err
	}
	nonceSlice, err := hpkeLabeledExpand(secret, []byte("base_nonce"), ksContext[:], 12)
	if err != nil {
		return nil, err
	}
	expSlice, err := hpkeLabeledExpand(secret, []byte("exp"), ksContext[:], 32)
	if err != nil {
		return nil, err
	}

	var sched HPKEBaseSchedule
	copy(sched.AEADKey[:], keySlice)
	copy(sched.BaseNonce[:], nonceSlice)
	copy(sched.ExporterSecret[:], expSlice)
	return &sched, nil
}

func HPKEXWingSealWithContext(sharedSecret [32]byte, info, aad, plaintext []byte) (*HPKEBaseSchedule, []byte, error) {
	sched, err := HPKEKeyScheduleBase(sharedSecret, info)
	if err != nil {
		return nil, nil, err
	}
	aead, err := chacha20poly1305.New(sched.AEADKey[:])
	if err != nil {
		return nil, nil, err
	}
	ct := aead.Seal(nil, sched.BaseNonce[:], plaintext, aad)
	return sched, ct, nil
}

func HPKEXWingSealDeterministic(pkBytes [XWingPKLen]byte, info, aad, plaintext []byte, encapSeed64 [64]byte) (*HPKESealedBox, error) {
	dbg, err := XWingEncapsulateDeterministic(pkBytes, encapSeed64)
	if err != nil {
		return nil, err
	}
	_, ct, err := HPKEXWingSealWithContext(dbg.SharedSecret, info, aad, plaintext)
	if err != nil {
		return nil, err
	}
	return &HPKESealedBox{
		Enc:        append([]byte(nil), dbg.Enc[:]...),
		Ciphertext: ct,
	}, nil
}

func HPKEXWingSeal(pkBytes [XWingPKLen]byte, info, aad, plaintext []byte) (*HPKESealedBox, error) {
	enc, ss, err := XWingEncapsulate(pkBytes)
	if err != nil {
		return nil, err
	}
	defer clear(ss[:])
	_, ct, err := HPKEXWingSealWithContext(ss, info, aad, plaintext)
	if err != nil {
		return nil, err
	}
	return &HPKESealedBox{
		Enc:        append([]byte(nil), enc[:]...),
		Ciphertext: ct,
	}, nil
}

func HPKEXWingOpen(recipient *XWingKeyPair, info, aad []byte, sealed *HPKESealedBox) ([]byte, error) {
	if len(sealed.Enc) != XWingEncLen {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: invalid X-Wing enc length %d", len(sealed.Enc))
	}
	var encArr [XWingEncLen]byte
	copy(encArr[:], sealed.Enc)
	ss, err := recipient.Decapsulate(encArr)
	if err != nil {
		return nil, err
	}
	defer clear(ss[:])
	sched, err := HPKEKeyScheduleBase(ss, info)
	if err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.New(sched.AEADKey[:])
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, sched.BaseNonce[:], sealed.Ciphertext, aad)
	if err != nil {
		return nil, errors.New("INTEGRITY_VIOLATION: HPKE ChaCha20Poly1305 open failed")
	}
	return plain, nil
}

func WrapWithPairingHPKE(agentID string, rootSecret [32]byte, peerPK [XWingPKLen]byte) (*store.KeySlotEnvelope, error) {
	aad := canonicalSlotAAD(agentID, "qr_pairing_hpke")
	sealed, err := HPKEXWingSeal(peerPK, []byte(PairingWrapInfo), []byte(aad), rootSecret[:])
	if err != nil {
		return nil, err
	}
	var zeroNonce [24]byte
	return &store.KeySlotEnvelope{
		AgentID:       agentID,
		Slot:          "qr_pairing_hpke",
		AADUTF8:       aad,
		NonceHex:      hex.EncodeToString(zeroNonce[:]),
		CiphertextHex: hex.EncodeToString(sealed.Ciphertext),
		HPKEEncHex:    hex.EncodeToString(sealed.Enc),
	}, nil
}

func UnwrapWithPairingHPKE(agentID string, recipient *XWingKeyPair, slot *store.KeySlotEnvelope) ([32]byte, error) {
	var out [32]byte
	if slot.Slot != "qr_pairing_hpke" || slot.AADUTF8 != canonicalSlotAAD(agentID, "qr_pairing_hpke") {
		return out, errors.New("INTEGRITY_VIOLATION: pairing slot AAD/type mismatch")
	}
	enc, err := hex.DecodeString(slot.HPKEEncHex)
	if err != nil {
		return out, err
	}
	ct, err := hex.DecodeString(slot.CiphertextHex)
	if err != nil {
		return out, err
	}
	plain, err := HPKEXWingOpen(recipient, []byte(PairingWrapInfo), []byte(slot.AADUTF8), &HPKESealedBox{
		Enc:        enc,
		Ciphertext: ct,
	})
	if err != nil {
		return out, err
	}
	defer clear(plain)
	if len(plain) != 32 {
		return out, errors.New("INTEGRITY_VIOLATION: unwrapped root key length != 32")
	}
	copy(out[:], plain)
	return out, nil
}

func membershipSigningDigest(agentID string, epoch uint64, op, deviceID string, devEd25519PK [32]byte, xwingBlake3Hex string) [32]byte {
	canonical := fmt.Sprintf(
		`{"agent_id":"%s","device_id":"%s","ed25519_pubkey":"%s","epoch":%d,"op":"%s","xwing_pubkey_blake3":"%s"}`,
		agentID, deviceID, hex.EncodeToString(devEd25519PK[:]), epoch, op, strings.ToLower(xwingBlake3Hex),
	)
	var digest [32]byte
	blake3.DeriveKey(digest[:], membershipDomainContext, []byte(canonical))
	return digest
}

func SignMembershipChange(rootEd25519Seed [32]byte, agentID string, epoch uint64, op string, deviceID string, devEd25519PK [32]byte, devXWingPK []byte) ([64]byte, string, error) {
	var sigArr [64]byte
	if len(devXWingPK) != XWingPKLen {
		return sigArr, "", fmt.Errorf("invalid X-Wing public key length %d", len(devXWingPK))
	}
	xwB3 := blake3.Sum256(devXWingPK)
	xwB3Hex := hex.EncodeToString(xwB3[:])
	digest := membershipSigningDigest(agentID, epoch, op, deviceID, devEd25519PK, xwB3Hex)
	priv := ed25519.NewKeyFromSeed(rootEd25519Seed[:])
	sig := ed25519.Sign(priv, digest[:])
	copy(sigArr[:], sig)
	return sigArr, xwB3Hex, nil
}

func VerifyMembershipChange(rootEd25519PK [32]byte, agentID string, epoch uint64, op string, deviceID string, devEd25519PK [32]byte, xwingBlake3Hex string, sig []byte) error {
	if len(sig) != ed25519.SignatureSize || len(xwingBlake3Hex) != 64 {
		return errors.New("INTEGRITY_VIOLATION: invalid membership signature or xwing hash")
	}
	digest := membershipSigningDigest(agentID, epoch, op, deviceID, devEd25519PK, xwingBlake3Hex)
	if !ed25519.Verify(ed25519.PublicKey(rootEd25519PK[:]), digest[:], sig) {
		return errors.New("INTEGRITY_VIOLATION: membership root Ed25519 signature invalid")
	}
	return nil
}

func (s *Service) computePairingCodeHMAC(pairingID, shortCode string) string {
	mac := hmac.New(sha256.New, s.cfg.PairingHMACSecret[:])
	_, _ = mac.Write([]byte("quetzalcoatl/v2/pairing-code:"))
	_, _ = mac.Write([]byte(pairingID))
	_, _ = mac.Write([]byte(":"))
	_, _ = mac.Write([]byte(strings.ToUpper(strings.TrimSpace(shortCode))))
	return hex.EncodeToString(mac.Sum(nil))
}

func generateShortCode() (string, error) {
	const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	out := make([]byte, 8)
	for i, b := range raw {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out[0:4]) + "-" + string(out[4:8]), nil
}

func (s *Service) handlePairInitiate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID string `json:"agent_id"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	principal, _, ok := s.requireAgentOwner(w, r, req.AgentID)
	if !ok {
		return
	}
	pairingID, err := randomIDHex(16)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	shortCode, err := generateShortCode()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	expiresAt := nowMs + pairingTTLMs
	if err := s.store.CreatePairingSession(r.Context(), store.PairingSession{
		PairingID:          pairingID,
		ShortCodeHMACHex:   s.computePairingCodeHMAC(pairingID, shortCode),
		AgentID:            req.AgentID,
		InitiatorAccountID: principal.AccountID,
		MaxAttempts:        pairingMaxAttempts,
		ExpiresAtMs:        expiresAt,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pairing_id":    pairingID,
		"short_code":    shortCode,
		"expires_at_ms": expiresAt,
	})
}

func (s *Service) handlePairJoin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PairingID        string `json:"pairing_id"`
		ShortCode        string `json:"short_code"`
		DeviceID         string `json:"device_id"`
		Ed25519PubKeyHex string `json:"ed25519_pubkey_hex"`
		XWingPubKeyHex   string `json:"xwing_pubkey_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if req.DeviceID == "" {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "missing device_id")
		return
	}
	if _, err := decodeHexFixed32(req.Ed25519PubKeyHex); err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid ed25519_pubkey_hex")
		return
	}
	xwBytes, err := hex.DecodeString(req.XWingPubKeyHex)
	if err != nil || len(xwBytes) != XWingPKLen {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "xwing_pubkey_hex must be 1216 bytes")
		return
	}
	if _, err := mlkem.NewEncapsulationKey768(xwBytes[0:1184]); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid ML-KEM-768 encapsulation key")
		return
	}

	nowMs := s.clock().UnixMilli()
	providedHMAC := s.computePairingCodeHMAC(req.PairingID, req.ShortCode)
	_, matched, err := s.store.RecordPairingAttempt(r.Context(), req.PairingID, "", providedHMAC, nowMs)
	if err != nil {
		if errors.Is(err, store.ErrLocked) {
			writeAPIError(w, http.StatusTooManyRequests, "CREDENTIAL_REJECTED", "pairing session locked after max attempts")
			return
		}
		writeAPIError(w, http.StatusForbidden, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	if !matched {
		writeAPIError(w, http.StatusForbidden, "CREDENTIAL_REJECTED", "invalid pairing short code")
		return
	}
	if err := s.store.UpdatePairingJoiner(r.Context(), req.PairingID, req.DeviceID, strings.ToLower(req.Ed25519PubKeyHex), strings.ToLower(req.XWingPubKeyHex)); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeAPIError(w, http.StatusConflict, "CREDENTIAL_REJECTED", "pairing session already joined or approved")
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "joined"})
}

func (s *Service) handlePairGet(w http.ResponseWriter, r *http.Request) {
	pairingID := r.PathValue("pairing_id")
	principal, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	ps, err := s.store.GetPairingSession(r.Context(), pairingID)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "INVALID_ID", "pairing session not found")
		return
	}
	if ps.InitiatorAccountID != principal.AccountID {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "caller does not own pairing session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"pairing_id":              ps.PairingID,
		"agent_id":                ps.AgentID,
		"new_device_id":           ps.NewDeviceID,
		"new_device_ed25519_hex":  ps.NewDeviceEd25519Hex,
		"new_device_xwing_pk_hex": ps.NewDeviceXWingPKHex,
		"expires_at_ms":           ps.ExpiresAtMs,
	})
}

func (s *Service) handlePairApprove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PairingID            string                `json:"pairing_id"`
		Epoch                uint64                `json:"epoch"`
		XWingPubKeyBlake3Hex string                `json:"xwing_pubkey_blake3_hex"`
		RootSignatureHex     string                `json:"root_signature_hex"`
		Slot2Envelope        store.KeySlotEnvelope `json:"slot2_envelope"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	principal, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	ps, err := s.store.GetPairingSession(r.Context(), req.PairingID)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "INVALID_ID", "pairing session not found")
		return
	}
	if ps.InitiatorAccountID != principal.AccountID {
		writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "caller does not own pairing session")
		return
	}
	nowMs := s.clock().UnixMilli()
	if ps.Locked || ps.Consumed || ps.ExpiresAtMs <= nowMs || ps.NewDeviceID == "" {
		writeAPIError(w, http.StatusConflict, "CREDENTIAL_REJECTED", "pairing session not joinable/expired")
		return
	}

	ag, err := s.store.GetAgent(r.Context(), ps.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "INVALID_ID", "agent not found")
		return
	}
	rootVK, err := decodeHexFixed32(ag.RootVerifyingKeyHex)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", "invalid agent root key")
		return
	}
	newDevEd, err := decodeHexFixed32(ps.NewDeviceEd25519Hex)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid joiner ed25519 key")
		return
	}
	xwBytes, _ := hex.DecodeString(ps.NewDeviceXWingPKHex)
	xwHash := blake3.Sum256(xwBytes)
	if strings.ToLower(req.XWingPubKeyBlake3Hex) != hex.EncodeToString(xwHash[:]) {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "xwing_pubkey_blake3 mismatch")
		return
	}
	rootSig, err := hex.DecodeString(req.RootSignatureHex)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid root_signature_hex")
		return
	}
	if err := VerifyMembershipChange(rootVK, ps.AgentID, req.Epoch, "add_device", ps.NewDeviceID, newDevEd, req.XWingPubKeyBlake3Hex, rootSig); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}

	expectedAAD := canonicalSlotAAD(ps.AgentID, "qr_pairing_hpke")
	encBytes, err := hex.DecodeString(req.Slot2Envelope.HPKEEncHex)
	if err != nil || len(encBytes) != XWingEncLen {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "slot2 hpke_enc must be 1120 bytes")
		return
	}
	ctBytes, err := hex.DecodeString(req.Slot2Envelope.CiphertextHex)
	if err != nil || len(ctBytes) != 48 || req.Slot2Envelope.AADUTF8 != expectedAAD {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "invalid slot2 HPKE ciphertext or AAD")
		return
	}

	if err := s.store.UpsertDevice(r.Context(), store.Device{
		AgentID:          ps.AgentID,
		DeviceID:         ps.NewDeviceID,
		AccountID:        ps.InitiatorAccountID,
		Ed25519PubKeyHex: ps.NewDeviceEd25519Hex,
		XWingPubKeyHex:   ps.NewDeviceXWingPKHex,
		CreatedAtMs:      nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       ps.AgentID,
		Slot:          "qr_pairing_hpke",
		AADUTF8:       expectedAAD,
		NonceHex:      strings.Repeat("0", 48),
		CiphertextHex: strings.ToLower(req.Slot2Envelope.CiphertextHex),
		HPKEEncHex:    strings.ToLower(req.Slot2Envelope.HPKEEncHex),
		UpdatedAtMs:   nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.ApprovePairingSession(r.Context(), ps.PairingID, strings.ToLower(req.Slot2Envelope.HPKEEncHex), strings.ToLower(req.Slot2Envelope.CiphertextHex), expectedAAD); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "approved"})
}

func (s *Service) handlePairComplete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PairingID          string `json:"pairing_id"`
		ShortCode          string `json:"short_code"`
		DeviceSignatureHex string `json:"device_signature_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	providedHMAC := s.computePairingCodeHMAC(req.PairingID, req.ShortCode)
	psCandidate, matched, err := s.store.RecordPairingAttempt(r.Context(), req.PairingID, "", providedHMAC, nowMs)
	if err != nil || !matched {
		writeAPIError(w, http.StatusForbidden, "CREDENTIAL_REJECTED", "invalid or locked pairing session")
		return
	}
	if psCandidate.CiphertextHex == "" || psCandidate.HPKEEncHex == "" || psCandidate.NewDeviceEd25519Hex == "" {
		writeAPIError(w, http.StatusConflict, "CREDENTIAL_REJECTED", "pairing session not yet approved")
		return
	}
	devPub, err := decodeHexFixed32(psCandidate.NewDeviceEd25519Hex)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	sigBytes, err := hex.DecodeString(req.DeviceSignatureHex)
	if err != nil || len(sigBytes) != ed25519.SignatureSize || !ed25519.Verify(ed25519.PublicKey(devPub[:]), []byte("quetzalcoatl/v2/pair-complete:"+psCandidate.PairingID), sigBytes) {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "invalid device proof signature")
		return
	}
	ps, err := s.store.ConsumePairingSession(r.Context(), req.PairingID, nowMs)
	if err != nil {
		writeAPIError(w, http.StatusConflict, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	rawToken, err := s.issueSession(r.Context(), ps.InitiatorAccountID, ps.AgentID, ps.NewDeviceID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_token": rawToken,
		"account_id":    ps.InitiatorAccountID,
		"agent_id":      ps.AgentID,
		"device_id":     ps.NewDeviceID,
		"slot2_envelope": store.KeySlotEnvelope{
			AgentID:       ps.AgentID,
			Slot:          "qr_pairing_hpke",
			AADUTF8:       ps.AADUTF8,
			NonceHex:      strings.Repeat("0", 48),
			CiphertextHex: ps.CiphertextHex,
			HPKEEncHex:    ps.HPKEEncHex,
		},
	})
}

func (s *Service) handleAddDevice(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID              string `json:"agent_id"`
		Epoch                uint64 `json:"epoch"`
		DeviceID             string `json:"device_id"`
		Ed25519PubKeyHex     string `json:"ed25519_pubkey_hex"`
		XWingPubKeyHex       string `json:"xwing_pubkey_hex"`
		XWingPubKeyBlake3Hex string `json:"xwing_pubkey_blake3_hex"`
		RootSignatureHex     string `json:"root_signature_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	principal, ag, ok := s.requireAgentOwner(w, r, req.AgentID)
	if !ok {
		return
	}
	rootVK, err := decodeHexFixed32(ag.RootVerifyingKeyHex)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", "invalid root key")
		return
	}
	devEd, err := decodeHexFixed32(req.Ed25519PubKeyHex)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid ed25519_pubkey_hex")
		return
	}
	xwBytes, err := hex.DecodeString(req.XWingPubKeyHex)
	if err != nil || len(xwBytes) != XWingPKLen {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "xwing_pubkey_hex must be 1216 bytes")
		return
	}
	xwB3 := blake3.Sum256(xwBytes)
	if strings.ToLower(req.XWingPubKeyBlake3Hex) != hex.EncodeToString(xwB3[:]) {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "xwing_pubkey_blake3 mismatch")
		return
	}
	sigBytes, err := hex.DecodeString(req.RootSignatureHex)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid root_signature_hex")
		return
	}
	if err := VerifyMembershipChange(rootVK, req.AgentID, req.Epoch, "add_device", req.DeviceID, devEd, req.XWingPubKeyBlake3Hex, sigBytes); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	if err := s.store.UpsertDevice(r.Context(), store.Device{
		AgentID:          req.AgentID,
		DeviceID:         req.DeviceID,
		AccountID:        principal.AccountID,
		Ed25519PubKeyHex: strings.ToLower(req.Ed25519PubKeyHex),
		XWingPubKeyHex:   strings.ToLower(req.XWingPubKeyHex),
		CreatedAtMs:      nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	rawToken, err := s.issueSession(r.Context(), principal.AccountID, req.AgentID, req.DeviceID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"session_token": rawToken,
		"device_id":     req.DeviceID,
	})
}

func (s *Service) handleListDevices(w http.ResponseWriter, r *http.Request) {
	agentID := r.PathValue("agent_id")
	if _, _, ok := s.requireAgentOwner(w, r, agentID); !ok {
		return
	}
	devs, err := s.store.ListDevices(r.Context(), agentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	type devResp struct {
		DeviceID         string `json:"device_id"`
		Ed25519PubKeyHex string `json:"ed25519_pubkey_hex"`
		XWingPubKeyHex   string `json:"xwing_pubkey_hex"`
		Revoked          bool   `json:"revoked"`
		CreatedAtMs      int64  `json:"created_at_ms"`
	}
	out := make([]devResp, 0, len(devs))
	for _, d := range devs {
		out = append(out, devResp{
			DeviceID:         d.DeviceID,
			Ed25519PubKeyHex: d.Ed25519PubKeyHex,
			XWingPubKeyHex:   d.XWingPubKeyHex,
			Revoked:          d.Revoked,
			CreatedAtMs:      d.CreatedAtMs,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

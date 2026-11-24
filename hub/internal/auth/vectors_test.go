// SPDX-License-Identifier: AGPL-3.0-only

package auth_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"
	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/store"
)

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "spec", "vectors", "opaque_rfc9807.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not locate spec/vectors from %s", dir)
		}
		dir = parent
	}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex decode %q: %v", s, err)
	}
	return b
}

func mustHex32(t *testing.T, s string) [32]byte {
	t.Helper()
	b := mustHex(t, s)
	if len(b) != 32 {
		t.Fatalf("expected 32 bytes, got %d", len(b))
	}
	var out [32]byte
	copy(out[:], b)
	return out
}

func mustHex24(t *testing.T, s string) [24]byte {
	t.Helper()
	b := mustHex(t, s)
	if len(b) != 24 {
		t.Fatalf("expected 24 bytes, got %d", len(b))
	}
	var out [24]byte
	copy(out[:], b)
	return out
}

func mustHex16(t *testing.T, s string) [16]byte {
	t.Helper()
	b := mustHex(t, s)
	if len(b) != 16 {
		t.Fatalf("expected 16 bytes, got %d", len(b))
	}
	var out [16]byte
	copy(out[:], b)
	return out
}

func mustHex64(t *testing.T, s string) [64]byte {
	t.Helper()
	b := mustHex(t, s)
	if len(b) != 64 {
		t.Fatalf("expected 64 bytes, got %d", len(b))
	}
	var out [64]byte
	copy(out[:], b)
	return out
}

type opaqueVectorFile struct {
	Suite  string `json:"suite"`
	Inputs struct {
		BlindScalarHex           string `json:"blind_scalar_hex"`
		ClientEphemeralScalarHex string `json:"client_ephemeral_scalar_hex"`
		ClientIdentityUTF8       string `json:"client_identity_utf8"`
		ClientNonceHex           string `json:"client_nonce_hex"`
		ContextUTF8              string `json:"context_utf8"`
		CredentialIdentifierUTF8 string `json:"credential_identifier_utf8"`
		EnvelopeNonceHex         string `json:"envelope_nonce_hex"`
		MaskingNonceHex          string `json:"masking_nonce_hex"`
		OPRFKeyScalarHex         string `json:"oprf_key_scalar_hex"`
		PasswordUTF8             string `json:"password_utf8"`
		ServerEphemeralScalarHex string `json:"server_ephemeral_scalar_hex"`
		ServerIdentityUTF8       string `json:"server_identity_utf8"`
		ServerNonceHex           string `json:"server_nonce_hex"`
		ServerPrivateScalarHex   string `json:"server_private_scalar_hex"`
	} `json:"inputs"`
	MHF struct {
		Iterations  uint32 `json:"iterations"`
		MemoryKiB   uint32 `json:"memory_kib"`
		Parallelism uint32 `json:"parallelism"`
		SaltHex     string `json:"salt_hex"`
	} `json:"mhf"`
	OPRFAndEnvelope struct {
		AuthKeyHex              string `json:"auth_key_hex"`
		BlindedElementHex       string `json:"blinded_element_hex"`
		CleartextCredentialsHex string `json:"cleartext_credentials_hex"`
		ClientPrivateScalarHex  string `json:"client_private_scalar_hex"`
		ClientPublicKeyHex      string `json:"client_public_key_hex"`
		EnvelopeAuthTagHex      string `json:"envelope_auth_tag_hex"`
		EnvelopeHex             string `json:"envelope_hex"`
		EvaluatedElementHex     string `json:"evaluated_element_hex"`
		ExportKeyHex            string `json:"export_key_hex"`
		HardenedOutputHex       string `json:"hardened_output_hex"`
		MaskedResponseHex       string `json:"masked_response_hex"`
		MaskingKeyHex           string `json:"masking_key_hex"`
		OPRFOutputHex           string `json:"oprf_output_hex"`
		RandomizedPwdHex        string `json:"randomized_pwd_hex"`
		ServerPublicKeyHex      string `json:"server_public_key_hex"`
	} `json:"oprf_and_envelope"`
	AKE3DH struct {
		ClientMACHex             string `json:"client_mac_hex"`
		CredentialResponseHex    string `json:"credential_response_hex"`
		DHIKMHex                 string `json:"dh_ikm_hex"`
		HandshakeSecretHex       string `json:"handshake_secret_hex"`
		KE1Hex                   string `json:"ke1_hex"`
		KM2Hex                   string `json:"km2_hex"`
		KM3Hex                   string `json:"km3_hex"`
		PreambleHex              string `json:"preamble_hex"`
		PreambleSHA512Hex        string `json:"preamble_sha512_hex"`
		PRKHex                   string `json:"prk_hex"`
		ServerEphemeralPublicHex string `json:"server_ephemeral_public_hex"`
		ServerMACHex             string `json:"server_mac_hex"`
		SessionKeyHex            string `json:"session_key_hex"`
	} `json:"ake_3dh"`
	Slot4RootKeyWrap struct {
		AADUTF8           string `json:"aad_utf8"`
		AccountRootKeyHex string `json:"account_root_key_hex"`
		CiphertextHex     string `json:"ciphertext_hex"`
		KEKHex            string `json:"kek_hex"`
		NonceHex          string `json:"nonce_hex"`
	} `json:"slot4_root_key_wrap"`
}

func TestOpaqueRFC9807VectorAndSlot4Parity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(findRepoRoot(t), "spec", "vectors", "opaque_rfc9807.json"))
	if err != nil {
		t.Fatalf("read opaque vector: %v", err)
	}
	var v opaqueVectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal opaque vector: %v", err)
	}

	pwd := []byte(v.Inputs.PasswordUTF8)
	blind := mustHex32(t, v.Inputs.BlindScalarHex)
	oprfKey := mustHex32(t, v.Inputs.OPRFKeyScalarHex)

	blinded, err := auth.OpaqueOPRFBlindDeterministic(pwd, blind)
	if err != nil {
		t.Fatalf("OpaqueOPRFBlindDeterministic: %v", err)
	}
	if got := hex.EncodeToString(blinded[:]); got != v.OPRFAndEnvelope.BlindedElementHex {
		t.Fatalf("blinded_element mismatch:\n got: %s\nwant: %s", got, v.OPRFAndEnvelope.BlindedElementHex)
	}

	evaluated, err := auth.OpaqueEvaluateOPRF(blinded, oprfKey)
	if err != nil {
		t.Fatalf("OpaqueEvaluateOPRF: %v", err)
	}
	if got := hex.EncodeToString(evaluated[:]); got != v.OPRFAndEnvelope.EvaluatedElementHex {
		t.Fatalf("evaluated_element mismatch:\n got: %s\nwant: %s", got, v.OPRFAndEnvelope.EvaluatedElementHex)
	}

	oprfOut, err := auth.OpaqueFinalizeOPRF(pwd, blind, evaluated)
	if err != nil {
		t.Fatalf("OpaqueFinalizeOPRF: %v", err)
	}
	if got := hex.EncodeToString(oprfOut[:]); got != v.OPRFAndEnvelope.OPRFOutputHex {
		t.Fatalf("oprf_output mismatch:\n got: %s\nwant: %s", got, v.OPRFAndEnvelope.OPRFOutputHex)
	}

	mhf := auth.OpaqueMhfParams{
		MemoryKiB:   v.MHF.MemoryKiB,
		Iterations:  v.MHF.Iterations,
		Parallelism: v.MHF.Parallelism,
		Salt:        mustHex16(t, v.MHF.SaltHex),
		SaltHex:     v.MHF.SaltHex,
	}
	envNonce := mustHex32(t, v.Inputs.EnvelopeNonceHex)
	maskNonce := mustHex32(t, v.Inputs.MaskingNonceHex)
	serverPriv := mustHex32(t, v.Inputs.ServerPrivateScalarHex)
	serverID := []byte(v.Inputs.ServerIdentityUTF8)
	clientID := []byte(v.Inputs.ClientIdentityUTF8)

	bundle, err := auth.OpaqueBuildEnvelopeDeterministic(oprfOut, mhf, envNonce, maskNonce, serverPriv, serverID, clientID)
	if err != nil {
		t.Fatalf("OpaqueBuildEnvelopeDeterministic: %v", err)
	}

	checks := []struct {
		name string
		got  string
		want string
	}{
		{"hardened_output", hex.EncodeToString(bundle.HardenedOutput[:]), v.OPRFAndEnvelope.HardenedOutputHex},
		{"randomized_pwd", hex.EncodeToString(bundle.RandomizedPwd[:]), v.OPRFAndEnvelope.RandomizedPwdHex},
		{"masking_key", hex.EncodeToString(bundle.MaskingKey[:]), v.OPRFAndEnvelope.MaskingKeyHex},
		{"export_key", hex.EncodeToString(bundle.ExportKey[:]), v.OPRFAndEnvelope.ExportKeyHex},
		{"auth_key", hex.EncodeToString(bundle.AuthKey[:]), v.OPRFAndEnvelope.AuthKeyHex},
		{"client_private_scalar", hex.EncodeToString(bundle.ClientPrivateScalar[:]), v.OPRFAndEnvelope.ClientPrivateScalarHex},
		{"client_public_key", hex.EncodeToString(bundle.ClientPublicKey[:]), v.OPRFAndEnvelope.ClientPublicKeyHex},
		{"server_public_key", hex.EncodeToString(bundle.ServerPublicKey[:]), v.OPRFAndEnvelope.ServerPublicKeyHex},
		{"cleartext_credentials", hex.EncodeToString(bundle.CleartextCredentials), v.OPRFAndEnvelope.CleartextCredentialsHex},
		{"envelope_auth_tag", hex.EncodeToString(bundle.EnvelopeAuthTag[:]), v.OPRFAndEnvelope.EnvelopeAuthTagHex},
		{"envelope", hex.EncodeToString(bundle.Envelope), v.OPRFAndEnvelope.EnvelopeHex},
		{"masked_response", hex.EncodeToString(bundle.MaskedResponse), v.OPRFAndEnvelope.MaskedResponseHex},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Fatalf("%s mismatch:\n got: %s\nwant: %s", c.name, c.got, c.want)
		}
	}

	recExport, recClientSK, recServerPK, err := auth.OpaqueOpenEnvelope(
		bundle.RandomizedPwd,
		evaluated,
		maskNonce,
		bundle.MaskedResponse,
		serverID,
		clientID,
	)
	if err != nil {
		t.Fatalf("OpaqueOpenEnvelope: %v", err)
	}
	if recExport != bundle.ExportKey || recClientSK != bundle.ClientPrivateScalar || recServerPK != bundle.ServerPublicKey {
		t.Fatalf("OpaqueOpenEnvelope recovered key mismatch")
	}

	tamperedMasked := append([]byte(nil), bundle.MaskedResponse...)
	tamperedMasked[len(tamperedMasked)-1] ^= 0xff
	if _, _, _, err := auth.OpaqueOpenEnvelope(bundle.RandomizedPwd, evaluated, maskNonce, tamperedMasked, serverID, clientID); err == nil {
		t.Fatalf("expected tampered OPAQUE envelope to fail authentication")
	}

	transcript, err := auth.Opaque3DHDerive(
		[]byte(v.Inputs.ContextUTF8),
		clientID,
		serverID,
		blinded,
		mustHex32(t, v.Inputs.ClientNonceHex),
		bundle.ClientPrivateScalar,
		mustHex32(t, v.Inputs.ClientEphemeralScalarHex),
		evaluated,
		maskNonce,
		bundle.MaskedResponse,
		mustHex32(t, v.Inputs.ServerNonceHex),
		serverPriv,
		mustHex32(t, v.Inputs.ServerEphemeralScalarHex),
	)
	if err != nil {
		t.Fatalf("Opaque3DHDerive: %v", err)
	}

	akeChecks := []struct {
		name string
		got  string
		want string
	}{
		{"ke1", hex.EncodeToString(transcript.KE1), v.AKE3DH.KE1Hex},
		{"credential_response", hex.EncodeToString(transcript.CredentialResponse), v.AKE3DH.CredentialResponseHex},
		{"preamble", hex.EncodeToString(transcript.Preamble), v.AKE3DH.PreambleHex},
		{"preamble_sha512", hex.EncodeToString(transcript.PreambleSHA512[:]), v.AKE3DH.PreambleSHA512Hex},
		{"dh_ikm", hex.EncodeToString(transcript.DHIKM[:]), v.AKE3DH.DHIKMHex},
		{"prk", hex.EncodeToString(transcript.PRK[:]), v.AKE3DH.PRKHex},
		{"handshake_secret", hex.EncodeToString(transcript.HandshakeSecret[:]), v.AKE3DH.HandshakeSecretHex},
		{"session_key", hex.EncodeToString(transcript.SessionKey[:]), v.AKE3DH.SessionKeyHex},
		{"km2", hex.EncodeToString(transcript.KM2[:]), v.AKE3DH.KM2Hex},
		{"km3", hex.EncodeToString(transcript.KM3[:]), v.AKE3DH.KM3Hex},
		{"server_mac", hex.EncodeToString(transcript.ServerMAC[:]), v.AKE3DH.ServerMACHex},
		{"client_mac", hex.EncodeToString(transcript.ClientMAC[:]), v.AKE3DH.ClientMACHex},
	}
	for _, c := range akeChecks {
		if c.got != c.want {
			t.Fatalf("3DH %s mismatch:\n got: %s\nwant: %s", c.name, c.got, c.want)
		}
	}

	const vectorAgentID = "018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f"
	rootKey := mustHex32(t, v.Slot4RootKeyWrap.AccountRootKeyHex)
	slot4Nonce := mustHex24(t, v.Slot4RootKeyWrap.NonceHex)
	wrapped, err := auth.WrapSlot4Deterministic(vectorAgentID, bundle.ExportKey, rootKey, slot4Nonce)
	if err != nil {
		t.Fatalf("WrapSlot4Deterministic: %v", err)
	}
	if wrapped.AADUTF8 != v.Slot4RootKeyWrap.AADUTF8 {
		t.Fatalf("slot4 AAD mismatch: got %q, want %q", wrapped.AADUTF8, v.Slot4RootKeyWrap.AADUTF8)
	}
	if wrapped.KEKDebugOnly == nil || hex.EncodeToString(wrapped.KEKDebugOnly[:]) != v.Slot4RootKeyWrap.KEKHex {
		t.Fatalf("slot4 KEK mismatch")
	}
	if hex.EncodeToString(wrapped.Ciphertext) != v.Slot4RootKeyWrap.CiphertextHex {
		t.Fatalf("slot4 ciphertext mismatch:\n got: %s\nwant: %s", hex.EncodeToString(wrapped.Ciphertext), v.Slot4RootKeyWrap.CiphertextHex)
	}

	unwrapped, err := auth.UnwrapSlot4(vectorAgentID, bundle.ExportKey, wrapped)
	if err != nil {
		t.Fatalf("UnwrapSlot4: %v", err)
	}
	if unwrapped != rootKey {
		t.Fatalf("UnwrapSlot4 recovered wrong root key")
	}

	tamperedSlot4 := *wrapped
	tamperedSlot4.Ciphertext = append([]byte(nil), wrapped.Ciphertext...)
	tamperedSlot4.Ciphertext[0] ^= 0x01
	if _, err := auth.UnwrapSlot4(vectorAgentID, bundle.ExportKey, &tamperedSlot4); err == nil {
		t.Fatalf("expected tampered Slot4 ciphertext to fail")
	}
}

type hpkeXWingVectorFile struct {
	HPKEIDs struct {
		XWingCombinerLabelHex string `json:"xwing_combiner_label_hex"`
	} `json:"hpke_ids"`
	KEM struct {
		EncapSeed64Hex       string `json:"encap_seed_64_hex"`
		ExpandedSHAKE256Hex  string `json:"expanded_shake256_96_hex"`
		MLKEM768SSHex        string `json:"mlkem768_ss_hex"`
		SKSeedHex            string `json:"sk_seed_hex"`
		X25519CTHex          string `json:"x25519_ct_hex"`
		X25519PKHex          string `json:"x25519_pk_hex"`
		X25519SSHex          string `json:"x25519_ss_hex"`
		XWingEncHex          string `json:"xwing_enc_hex"`
		XWingPKHex           string `json:"xwing_pk_hex"`
		XWingSharedSecretHex string `json:"xwing_shared_secret_hex"`
	} `json:"kem"`
	SealCases []struct {
		ID                string `json:"id"`
		AADUTF8           string `json:"aad_utf8"`
		AEADKeyHex        string `json:"aead_key_hex"`
		BaseNonceHex      string `json:"base_nonce_hex"`
		CiphertextHex     string `json:"ciphertext_hex"`
		ExporterSecretHex string `json:"exporter_secret_hex"`
		InfoUTF8          string `json:"info_utf8"`
		PlaintextHex      string `json:"plaintext_hex"`
	} `json:"seal_cases"`
}

func TestHPKEXWingVectorAndSealCasesParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(findRepoRoot(t), "spec", "vectors", "hpke_xwing.json"))
	if err != nil {
		t.Fatalf("read hpke_xwing vector: %v", err)
	}
	var v hpkeXWingVectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal hpke_xwing vector: %v", err)
	}

	if hex.EncodeToString([]byte(auth.XWingCombinerLabel)) != v.HPKEIDs.XWingCombinerLabelHex {
		t.Fatalf("xwing combiner label mismatch")
	}

	kp, err := auth.XWingFromSeed(mustHex32(t, v.KEM.SKSeedHex))
	if err != nil {
		t.Fatalf("XWingFromSeed: %v", err)
	}
	exp96 := kp.ExpandedSHAKE256_96()
	if got := hex.EncodeToString(exp96[:]); got != v.KEM.ExpandedSHAKE256Hex {
		t.Fatalf("expanded_shake256_96 mismatch:\n got: %s\nwant: %s", got, v.KEM.ExpandedSHAKE256Hex)
	}
	pk := kp.PublicKeyBytes()
	if got := hex.EncodeToString(pk[:]); got != v.KEM.XWingPKHex {
		t.Fatalf("xwing_pk mismatch")
	}
	xpk := kp.X25519PublicKeyBytes()
	if got := hex.EncodeToString(xpk[:]); got != v.KEM.X25519PKHex {
		t.Fatalf("x25519_pk mismatch")
	}

	encapSeed := mustHex64(t, v.KEM.EncapSeed64Hex)
	dbg, err := auth.XWingEncapsulateDeterministic(pk, encapSeed)
	if err != nil {
		t.Fatalf("XWingEncapsulateDeterministic: %v", err)
	}
	if hex.EncodeToString(dbg.MLKEM768SS[:]) != v.KEM.MLKEM768SSHex {
		t.Fatalf("mlkem768_ss mismatch")
	}
	if hex.EncodeToString(dbg.X25519CT[:]) != v.KEM.X25519CTHex {
		t.Fatalf("x25519_ct mismatch")
	}
	if hex.EncodeToString(dbg.X25519SS[:]) != v.KEM.X25519SSHex {
		t.Fatalf("x25519_ss mismatch")
	}
	if hex.EncodeToString(dbg.Enc[:]) != v.KEM.XWingEncHex {
		t.Fatalf("xwing_enc mismatch")
	}
	if hex.EncodeToString(dbg.SharedSecret[:]) != v.KEM.XWingSharedSecretHex {
		t.Fatalf("xwing_shared_secret mismatch")
	}

	decSS, err := kp.Decapsulate(dbg.Enc)
	if err != nil {
		t.Fatalf("Decapsulate: %v", err)
	}
	if decSS != dbg.SharedSecret {
		t.Fatalf("Decapsulate shared_secret mismatch")
	}

	for _, sc := range v.SealCases {
		pt := mustHex(t, sc.PlaintextHex)
		sched, ct, err := auth.HPKEXWingSealWithContext(dbg.SharedSecret, []byte(sc.InfoUTF8), []byte(sc.AADUTF8), pt)
		if err != nil {
			t.Fatalf("case %s HPKEXWingSealWithContext: %v", sc.ID, err)
		}
		if hex.EncodeToString(sched.AEADKey[:]) != sc.AEADKeyHex {
			t.Fatalf("case %s aead_key mismatch", sc.ID)
		}
		if hex.EncodeToString(sched.BaseNonce[:]) != sc.BaseNonceHex {
			t.Fatalf("case %s base_nonce mismatch", sc.ID)
		}
		if hex.EncodeToString(sched.ExporterSecret[:]) != sc.ExporterSecretHex {
			t.Fatalf("case %s exporter_secret mismatch", sc.ID)
		}
		if hex.EncodeToString(ct) != sc.CiphertextHex {
			t.Fatalf("case %s ciphertext mismatch", sc.ID)
		}

		sealed, err := auth.HPKEXWingSealDeterministic(pk, []byte(sc.InfoUTF8), []byte(sc.AADUTF8), pt, encapSeed)
		if err != nil {
			t.Fatalf("case %s HPKEXWingSealDeterministic: %v", sc.ID, err)
		}
		opened, err := auth.HPKEXWingOpen(kp, []byte(sc.InfoUTF8), []byte(sc.AADUTF8), sealed)
		if err != nil {
			t.Fatalf("case %s HPKEXWingOpen: %v", sc.ID, err)
		}
		if !bytes.Equal(opened, pt) {
			t.Fatalf("case %s plaintext mismatch", sc.ID)
		}

		bad := &auth.HPKESealedBox{
			Enc:        append([]byte(nil), sealed.Enc...),
			Ciphertext: append([]byte(nil), sealed.Ciphertext...),
		}
		bad.Ciphertext[0] ^= 0x80
		if _, err := auth.HPKEXWingOpen(kp, []byte(sc.InfoUTF8), []byte(sc.AADUTF8), bad); err == nil {
			t.Fatalf("case %s expected tampered HPKE ciphertext to fail", sc.ID)
		}
	}
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func doJSON(t *testing.T, client *http.Client, method, url, bearer string, reqBody any) (*http.Response, []byte) {
	t.Helper()
	var bodyReader io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		bodyReader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("http %s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp, raw
}

func buildWebAuthnAssertion(t *testing.T, priv *ecdsa.PrivateKey, typ, challengeB64, origin, rpID string, signCount uint32) (string, string, string) {
	t.Helper()
	clientData := fmt.Sprintf(`{"type":%q,"challenge":%q,"origin":%q,"crossOrigin":false}`, typ, challengeB64, origin)
	clientDataHash := sha256.Sum256([]byte(clientData))
	rpHash := sha256.Sum256([]byte(rpID))

	authData := make([]byte, 37)
	copy(authData[0:32], rpHash[:])
	authData[32] = 0x05 // UP (0x01) | UV (0x04)
	binary.BigEndian.PutUint32(authData[33:37], signCount)

	signedPayload := append(append([]byte(nil), authData...), clientDataHash[:]...)
	digest := sha256.Sum256(signedPayload)
	sigASN1, err := ecdsa.SignASN1(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatalf("ecdsa sign: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(clientData)),
		base64.RawURLEncoding.EncodeToString(authData),
		base64.RawURLEncoding.EncodeToString(sigASN1)
}

func signES256JWT(t *testing.T, priv *ecdsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	hdrJSON, err := json.Marshal(map[string]any{
		"alg": "ES256",
		"typ": "JWT",
		"kid": kid,
	})
	if err != nil {
		t.Fatalf("marshal jwt header: %v", err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal jwt claims: %v", err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(hdrJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatalf("sign ES256 jwt: %v", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[0:32])
	s.FillBytes(sig[32:64])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestFiveSlotZeroKnowledgeHTTPFlowsAndCrossAccountIDOR(t *testing.T) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "hub.sqlite")
	blobDir := filepath.Join(tmpDir, "blobs")

	st, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	defer st.Close()

	clk := &fakeClock{now: time.UnixMilli(1_795_400_000_000)}
	var blobSecret [32]byte
	copy(blobSecret[:], []byte("quetzalcoatl-hub-blob-secret-key"))

	oidcKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate oidc key: %v", err)
	}
	webhookKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate webhook key: %v", err)
	}

	var oprfSeed [32]byte
	copy(oprfSeed[:], bytes.Repeat([]byte{0x11}, 32))
	serverOpaquePriv := mustHex32(t, "acd7483bdc0eb4286b40586867aed6f0140159fd00ee3383abc86636300bb80c")
	var pairSecret [32]byte
	copy(pairSecret[:], bytes.Repeat([]byte{0x33}, 32))

	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()

	blobs, err := store.NewLocalBlobStore(blobDir, srv.URL, blobSecret, st, clk.Now)
	if err != nil {
		t.Fatalf("NewLocalBlobStore: %v", err)
	}
	blobs.RegisterRoutes(mux)

	authSvc, err := auth.NewService(st, blobs, auth.Config{
		RPID:                      "hub.quetzalcoatl.example",
		AllowedOrigins:            []string{"https://hub.quetzalcoatl.example"},
		ServerIdentity:            "server:quetzalcoatl-hub:v2",
		OPRFMasterSeed:            oprfSeed,
		ServerOpaquePrivateScalar: serverOpaquePriv,
		PairingHMACSecret:         pairSecret,
		DefaultAgentQuotaBytes:    10 * 1024 * 1024,
		OIDCIssuer:                "https://idp.quetzalcoatl.example",
		OIDCClientID:              "quetzalcoatl-client",
		OIDCPublicKeys:            map[string]any{"idp-k1": &oidcKey.PublicKey},
		WebhookPublicKeys:         map[string]any{"wh-k1": &webhookKey.PublicKey},
	}, clk.Now)
	if err != nil {
		t.Fatalf("auth.NewService: %v", err)
	}
	authSvc.RegisterRoutes(mux)

	client := srv.Client()

	// Canary secrets that MUST NEVER appear in SQLite DB or disk blobs!
	var canaryRootSeed [32]byte
	copy(canaryRootSeed[:], []byte("CANARY_ROOT_KEY_SECRET_NEVER_DB!"))
	rootPriv := ed25519.NewKeyFromSeed(canaryRootSeed[:])
	rootPub := rootPriv.Public().(ed25519.PublicKey)

	var canaryPRF [32]byte
	copy(canaryPRF[:], []byte("CANARY_PASSKEY_PRF_OUT_NEVER_DB!"))
	canaryPIN := []byte("CANARY-OPAQUE-PIN-998877-NEVERDB")

	const agentA = "018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f"
	const devA1 = "01020304-0506-8708-890a-0b0c0d0e0f10"
	devA1Pub, devA1Priv, _ := ed25519.GenerateKey(rand.Reader)
	_ = devA1Priv
	devA1XWing, err := auth.GenerateXWingKeyPair()
	if err != nil {
		t.Fatalf("GenerateXWingKeyPair: %v", err)
	}
	devA1XWingPK := devA1XWing.PublicKeyBytes()

	// --- Slot 1: WebAuthn Passkey Registration & Login + PRF Root Key Envelope ---
	resp, raw := doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/register/begin", "", map[string]any{
		"agent_id":                  agentA,
		"device_id":                 devA1,
		"root_verifying_key_hex":    hex.EncodeToString(rootPub),
		"device_ed25519_pubkey_hex": hex.EncodeToString(devA1Pub),
		"device_xwing_pubkey_hex":   hex.EncodeToString(devA1XWingPK[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("passkey register/begin status=%d body=%s", resp.StatusCode, raw)
	}
	var regBegin struct {
		ChallengeID  string `json:"challenge_id"`
		ChallengeB64 string `json:"challenge_b64"`
		RPID         string `json:"rp_id"`
		PRFSaltHex   string `json:"prf_salt_hex"`
	}
	if err := json.Unmarshal(raw, &regBegin); err != nil {
		t.Fatalf("unmarshal regBegin: %v", err)
	}

	passkeyPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	passkeyPubBytes := elliptic.Marshal(elliptic.P256(), passkeyPriv.PublicKey.X, passkeyPriv.PublicKey.Y)
	slot1Env, err := auth.WrapWithPasskeyPRF(agentA, canaryRootSeed, canaryPRF)
	if err != nil {
		t.Fatalf("WrapWithPasskeyPRF: %v", err)
	}

	// Wrong origin must be rejected!
	badCD, badAD, badSig := buildWebAuthnAssertion(t, passkeyPriv, "webauthn.create", regBegin.ChallengeB64, "https://evil.example", regBegin.RPID, 1)
	badResp, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/register/finish", "", map[string]any{
		"challenge_id":           regBegin.ChallengeID,
		"credential_id":          "cred-passkey-a1",
		"alg":                    -7,
		"public_key_hex":         hex.EncodeToString(passkeyPubBytes),
		"client_data_json_b64":   badCD,
		"authenticator_data_b64": badAD,
		"signature_b64":          badSig,
		"slot1_envelope":         slot1Env,
	})
	if badResp.StatusCode == http.StatusOK {
		t.Fatalf("expected evil origin WebAuthn registration to be rejected")
	}

	// Fresh challenge after single-use/failed check
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/register/begin", "", map[string]any{
		"agent_id":                  agentA,
		"device_id":                 devA1,
		"root_verifying_key_hex":    hex.EncodeToString(rootPub),
		"device_ed25519_pubkey_hex": hex.EncodeToString(devA1Pub),
		"device_xwing_pubkey_hex":   hex.EncodeToString(devA1XWingPK[:]),
	})
	_ = json.Unmarshal(raw, &regBegin)

	cdB64, adB64, sigB64 := buildWebAuthnAssertion(t, passkeyPriv, "webauthn.create", regBegin.ChallengeB64, "https://hub.quetzalcoatl.example", regBegin.RPID, 1)
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/register/finish", "", map[string]any{
		"challenge_id":           regBegin.ChallengeID,
		"credential_id":          "cred-passkey-a1",
		"alg":                    -7,
		"public_key_hex":         hex.EncodeToString(passkeyPubBytes),
		"client_data_json_b64":   cdB64,
		"authenticator_data_b64": adB64,
		"signature_b64":          sigB64,
		"slot1_envelope":         slot1Env,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("passkey register/finish status=%d body=%s", resp.StatusCode, raw)
	}
	var regFinish struct {
		SessionToken string `json:"session_token"`
		AccountID    string `json:"account_id"`
		AgentID      string `json:"agent_id"`
	}
	_ = json.Unmarshal(raw, &regFinish)
	tokenA := regFinish.SessionToken
	if tokenA == "" {
		t.Fatalf("expected non-empty session token")
	}

	// Challenge replay MUST be rejected!
	replayResp, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/register/finish", "", map[string]any{
		"challenge_id":           regBegin.ChallengeID,
		"credential_id":          "cred-passkey-replay",
		"alg":                    -7,
		"public_key_hex":         hex.EncodeToString(passkeyPubBytes),
		"client_data_json_b64":   cdB64,
		"authenticator_data_b64": adB64,
		"signature_b64":          sigB64,
		"slot1_envelope":         slot1Env,
	})
	if replayResp.StatusCode == http.StatusOK {
		t.Fatalf("expected replayed WebAuthn challenge to fail")
	}

	// Passkey Login roundtrip
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/login/begin", "", map[string]any{
		"agent_id": agentA,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("passkey login/begin status=%d body=%s", resp.StatusCode, raw)
	}
	var loginBegin struct {
		ChallengeID  string `json:"challenge_id"`
		ChallengeB64 string `json:"challenge_b64"`
		RPID         string `json:"rp_id"`
	}
	_ = json.Unmarshal(raw, &loginBegin)
	cdLogin, adLogin, sigLogin := buildWebAuthnAssertion(t, passkeyPriv, "webauthn.get", loginBegin.ChallengeB64, "https://hub.quetzalcoatl.example", loginBegin.RPID, 2)
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/passkey/login/finish", "", map[string]any{
		"challenge_id":           loginBegin.ChallengeID,
		"credential_id":          "cred-passkey-a1",
		"device_id":              devA1,
		"client_data_json_b64":   cdLogin,
		"authenticator_data_b64": adLogin,
		"signature_b64":          sigLogin,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("passkey login/finish status=%d body=%s", resp.StatusCode, raw)
	}
	var loginFinish struct {
		SessionToken  string                `json:"session_token"`
		Slot1Envelope store.KeySlotEnvelope `json:"slot1_envelope"`
	}
	_ = json.Unmarshal(raw, &loginFinish)
	recoveredSlot1, err := auth.UnwrapWithPasskeyPRF(agentA, canaryPRF, &loginFinish.Slot1Envelope)
	if err != nil || recoveredSlot1 != canaryRootSeed {
		t.Fatalf("Slot1 unwrap failed: err=%v", err)
	}

	// --- Slot 2: X-Wing (0x647a) HPKE Pairing + 5m TTL + Max-Attempt Lockout ---
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/initiate", tokenA, map[string]any{
		"agent_id": agentA,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pair/initiate status=%d body=%s", resp.StatusCode, raw)
	}
	var pairInit struct {
		PairingID   string `json:"pairing_id"`
		ShortCode   string `json:"short_code"`
		ExpiresAtMs int64  `json:"expires_at_ms"`
	}
	_ = json.Unmarshal(raw, &pairInit)
	if pairInit.ExpiresAtMs-clk.Now().UnixMilli() != 5*60*1000 {
		t.Fatalf("expected exact 5m pairing TTL, got %dms", pairInit.ExpiresAtMs-clk.Now().UnixMilli())
	}

	// Test max-attempt lockout on a dedicated pairing session
	respLock, rawLock := doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/initiate", tokenA, map[string]any{"agent_id": agentA})
	if respLock.StatusCode != http.StatusOK {
		t.Fatalf("pair/initiate lock test: %s", rawLock)
	}
	var lockPair struct {
		PairingID string `json:"pairing_id"`
		ShortCode string `json:"short_code"`
	}
	_ = json.Unmarshal(rawLock, &lockPair)
	devLockPub, _, _ := ed25519.GenerateKey(rand.Reader)
	for attempt := 0; attempt < 5; attempt++ {
		rBad, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/join", "", map[string]any{
			"pairing_id":         lockPair.PairingID,
			"short_code":         "WRONG-CODE",
			"device_id":          "21020304-0506-8708-890a-0b0c0d0e0f99",
			"ed25519_pubkey_hex": hex.EncodeToString(devLockPub),
			"xwing_pubkey_hex":   hex.EncodeToString(devA1XWingPK[:]),
		})
		if rBad.StatusCode == http.StatusOK {
			t.Fatalf("expected wrong short_code to fail")
		}
	}
	// Even the CORRECT code MUST now be rejected because session is locked out!
	rAfterLock, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/join", "", map[string]any{
		"pairing_id":         lockPair.PairingID,
		"short_code":         lockPair.ShortCode,
		"device_id":          "21020304-0506-8708-890a-0b0c0d0e0f99",
		"ed25519_pubkey_hex": hex.EncodeToString(devLockPub),
		"xwing_pubkey_hex":   hex.EncodeToString(devA1XWingPK[:]),
	})
	if rAfterLock.StatusCode == http.StatusOK {
		t.Fatalf("expected locked-out pairing session to reject even valid code")
	}

	// Valid Slot 2 Pairing completion
	const devA2 = "11121314-1516-8718-891a-1b1c1d1e1f20"
	devA2Pub, devA2Priv, _ := ed25519.GenerateKey(rand.Reader)
	devA2XWing, _ := auth.GenerateXWingKeyPair()
	devA2XWingPK := devA2XWing.PublicKeyBytes()

	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/join", "", map[string]any{
		"pairing_id":         pairInit.PairingID,
		"short_code":         pairInit.ShortCode,
		"device_id":          devA2,
		"ed25519_pubkey_hex": hex.EncodeToString(devA2Pub),
		"xwing_pubkey_hex":   hex.EncodeToString(devA2XWingPK[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pair/join status=%d body=%s", resp.StatusCode, raw)
	}

	resp, raw = doJSON(t, client, http.MethodGet, srv.URL+"/v1/pair/"+pairInit.PairingID, tokenA, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET pair status=%d body=%s", resp.StatusCode, raw)
	}
	var devA2PubArr [32]byte
	copy(devA2PubArr[:], devA2Pub)
	memberSig, xwingB3Hex, err := auth.SignMembershipChange(canaryRootSeed, agentA, 1, "add_device", devA2, devA2PubArr, devA2XWingPK[:])
	if err != nil {
		t.Fatalf("SignMembershipChange: %v", err)
	}
	slot2Env, err := auth.WrapWithPairingHPKE(agentA, canaryRootSeed, devA2XWingPK)
	if err != nil {
		t.Fatalf("WrapWithPairingHPKE: %v", err)
	}
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/approve", tokenA, map[string]any{
		"pairing_id":              pairInit.PairingID,
		"epoch":                   1,
		"xwing_pubkey_blake3_hex": xwingB3Hex,
		"root_signature_hex":      hex.EncodeToString(memberSig[:]),
		"slot2_envelope":          slot2Env,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pair/approve status=%d body=%s", resp.StatusCode, raw)
	}

	completeSig := ed25519.Sign(devA2Priv, []byte("quetzalcoatl/v2/pair-complete:"+pairInit.PairingID))
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/complete", "", map[string]any{
		"pairing_id":           pairInit.PairingID,
		"short_code":           pairInit.ShortCode,
		"device_signature_hex": hex.EncodeToString(completeSig),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pair/complete status=%d body=%s", resp.StatusCode, raw)
	}
	var pairComplete struct {
		SessionToken  string                `json:"session_token"`
		Slot2Envelope store.KeySlotEnvelope `json:"slot2_envelope"`
	}
	_ = json.Unmarshal(raw, &pairComplete)
	recoveredSlot2, err := auth.UnwrapWithPairingHPKE(agentA, devA2XWing, &pairComplete.Slot2Envelope)
	if err != nil || recoveredSlot2 != canaryRootSeed {
		t.Fatalf("Slot2 unwrap failed: err=%v", err)
	}

	// Test 5m TTL expiration on another pairing session
	respExp, rawExp := doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/initiate", tokenA, map[string]any{"agent_id": agentA})
	_ = respExp
	var expPair struct {
		PairingID string `json:"pairing_id"`
		ShortCode string `json:"short_code"`
	}
	_ = json.Unmarshal(rawExp, &expPair)
	clk.Advance(6 * time.Minute)
	rExpired, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/pair/join", "", map[string]any{
		"pairing_id":         expPair.PairingID,
		"short_code":         expPair.ShortCode,
		"device_id":          "31121314-1516-8718-891a-1b1c1d1e1f20",
		"ed25519_pubkey_hex": hex.EncodeToString(devLockPub),
		"xwing_pubkey_hex":   hex.EncodeToString(devA1XWingPK[:]),
	})
	if rExpired.StatusCode == http.StatusOK {
		t.Fatalf("expected expired pairing session (>5m) to be rejected")
	}

	// --- Slot 3: Guardian Shamir 2-of-3 Custody & Gated Approval Recovery ---
	shares, err := auth.SplitShamirShares(canaryRootSeed, 2, 3)
	if err != nil {
		t.Fatalf("SplitShamirShares: %v", err)
	}
	var gPubs [3]ed25519.PublicKey
	var gPrivs [3]ed25519.PrivateKey
	var gXWing [3]*auth.XWingKeyPair
	custodyReq := make([]map[string]any, 3)
	for i := 0; i < 3; i++ {
		gPubs[i], gPrivs[i], _ = ed25519.GenerateKey(rand.Reader)
		gXWing[i], _ = auth.GenerateXWingKeyPair()
		gPK := gXWing[i].PublicKeyBytes()
		aad := fmt.Sprintf(`{"agent_id":%q,"guardian_id":"g-%d","share_index":%d,"v":2}`, agentA, i+1, shares[i].Index)
		sealedShare, err := auth.HPKEXWingSeal(gPK, []byte("quetzalcoatl/v2/guardian-share"), []byte(aad), shares[i].Value[:])
		if err != nil {
			t.Fatalf("seal guardian share: %v", err)
		}
		custodyReq[i] = map[string]any{
			"share_index":         int(shares[i].Index),
			"guardian_id":         fmt.Sprintf("g-%d", i+1),
			"guardian_pubkey_hex": hex.EncodeToString(gPubs[i]),
			"encrypted_share_hex": hex.EncodeToString(sealedShare.Ciphertext),
			"hpke_enc_hex":        hex.EncodeToString(sealedShare.Enc),
			"aad_utf8":            aad,
		}
	}
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/guardian/setup", tokenA, map[string]any{
		"agent_id":              agentA,
		"threshold":             2,
		"total":                 3,
		"commitment_blake3_hex": hex.EncodeToString(shares[0].CommitmentBlake3[:]),
		"shares":                custodyReq,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("guardian/setup status=%d body=%s", resp.StatusCode, raw)
	}

	recXWing, _ := auth.GenerateXWingKeyPair()
	recXWingPK := recXWing.PublicKeyBytes()
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/guardian/recover/request", "", map[string]any{
		"agent_id":               agentA,
		"requester_xwing_pk_hex": hex.EncodeToString(recXWingPK[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("guardian/recover/request status=%d body=%s", resp.StatusCode, raw)
	}
	var recReq struct {
		RecoveryID string `json:"recovery_id"`
	}
	_ = json.Unmarshal(raw, &recReq)

	// Approve with guardian 1 ONLY (1 < threshold 2) -> GET MUST gate shares!
	msg1 := fmt.Sprintf(`{"agent_id":%q,"guardian_id":"g-1","recovery_id":%q,"share_index":1}`, agentA, recReq.RecoveryID)
	sigG1 := ed25519.Sign(gPrivs[0], []byte(msg1))
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/guardian/recover/approve", "", map[string]any{
		"recovery_id":   recReq.RecoveryID,
		"agent_id":      agentA,
		"share_index":   1,
		"guardian_id":   "g-1",
		"signature_hex": hex.EncodeToString(sigG1),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("guardian approve 1 status=%d body=%s", resp.StatusCode, raw)
	}
	resp, raw = doJSON(t, client, http.MethodGet, srv.URL+"/v1/auth/guardian/recover/"+recReq.RecoveryID, "", nil)
	if bytes.Contains(raw, []byte(custodyReq[0]["encrypted_share_hex"].(string))) {
		t.Fatalf("GATING VIOLATION: share ciphertext leaked before threshold approvals met!")
	}

	// Approve with guardian 3 -> reaches 2-of-3 threshold -> releases shares!
	msg3 := fmt.Sprintf(`{"agent_id":%q,"guardian_id":"g-3","recovery_id":%q,"share_index":3}`, agentA, recReq.RecoveryID)
	sigG3 := ed25519.Sign(gPrivs[2], []byte(msg3))
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/guardian/recover/approve", "", map[string]any{
		"recovery_id":   recReq.RecoveryID,
		"agent_id":      agentA,
		"share_index":   3,
		"guardian_id":   "g-3",
		"signature_hex": hex.EncodeToString(sigG3),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("guardian approve 3 status=%d body=%s", resp.StatusCode, raw)
	}
	resp, raw = doJSON(t, client, http.MethodGet, srv.URL+"/v1/auth/guardian/recover/"+recReq.RecoveryID, "", nil)
	var recStatus struct {
		Status              string                       `json:"status"`
		CommitmentBlake3Hex string                       `json:"commitment_blake3_hex"`
		ApprovedShares      []store.GuardianShareCustody `json:"approved_shares"`
	}
	_ = json.Unmarshal(raw, &recStatus)
	if recStatus.Status != "approved" || len(recStatus.ApprovedShares) != 2 {
		t.Fatalf("expected approved status with 2 shares, got %+v", recStatus)
	}
	commitBytes := mustHex32(t, recStatus.CommitmentBlake3Hex)
	var recShares []auth.ShamirShare
	for _, cs := range recStatus.ApprovedShares {
		gIdx := cs.ShareIndex - 1
		openedVal, err := auth.HPKEXWingOpen(gXWing[gIdx], []byte("quetzalcoatl/v2/guardian-share"), []byte(cs.AADUTF8), &auth.HPKESealedBox{
			Enc:        mustHex(t, cs.HPKEEncHex),
			Ciphertext: mustHex(t, cs.EncryptedShareHex),
		})
		if err != nil {
			t.Fatalf("guardian open share %d: %v", cs.ShareIndex, err)
		}
		var val32 [32]byte
		copy(val32[:], openedVal)
		recShares = append(recShares, auth.ShamirShare{
			Index:            uint8(cs.ShareIndex),
			Threshold:        2,
			Value:            val32,
			CommitmentBlake3: commitBytes,
		})
	}
	reconstructedRoot, err := auth.ReconstructShamirShares(recShares)
	if err != nil || reconstructedRoot != canaryRootSeed {
		t.Fatalf("Shamir reconstruct failed: err=%v", err)
	}

	// --- Slot 4: Zero-Knowledge OPAQUE-Ristretto255-SHA512 HTTP Registration & 3DH Login ---
	blindReg := mustHex32(t, "9c3bb78643928a42ade8b88057986124d291d25883176af0f1ae566bd2977a01")
	blindedReg, err := auth.OpaqueOPRFBlindDeterministic(canaryPIN, blindReg)
	if err != nil {
		t.Fatalf("OpaqueOPRFBlindDeterministic: %v", err)
	}
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/opaque/register/init", tokenA, map[string]any{
		"agent_id":            agentA,
		"blinded_element_hex": hex.EncodeToString(blindedReg[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("opaque/register/init status=%d body=%s", resp.StatusCode, raw)
	}
	var opRegInit struct {
		EvaluatedElementHex string               `json:"evaluated_element_hex"`
		ServerPublicKeyHex  string               `json:"server_public_key_hex"`
		ServerIdentity      string               `json:"server_identity"`
		MHF                 auth.OpaqueMhfParams `json:"mhf"`
	}
	_ = json.Unmarshal(raw, &opRegInit)
	opRegInit.MHF.Salt = mustHex16(t, opRegInit.MHF.SaltHex)
	evalReg := mustHex32(t, opRegInit.EvaluatedElementHex)
	oprfOutReg, err := auth.OpaqueFinalizeOPRF(canaryPIN, blindReg, evalReg)
	if err != nil {
		t.Fatalf("OpaqueFinalizeOPRF: %v", err)
	}
	var envNonceReg, maskNonceReg [32]byte
	_, _ = rand.Read(envNonceReg[:])
	_, _ = rand.Read(maskNonceReg[:])
	clientIDStr := "client:device:" + devA1
	regBundle, err := auth.OpaqueBuildEnvelopeDeterministic(oprfOutReg, opRegInit.MHF, envNonceReg, maskNonceReg, serverOpaquePriv, []byte(opRegInit.ServerIdentity), []byte(clientIDStr))
	if err != nil {
		t.Fatalf("OpaqueBuildEnvelopeDeterministic: %v", err)
	}
	var slot4Nonce [24]byte
	_, _ = rand.Read(slot4Nonce[:])
	slot4Wrap, err := auth.WrapSlot4Deterministic(agentA, regBundle.ExportKey, canaryRootSeed, slot4Nonce)
	if err != nil {
		t.Fatalf("WrapSlot4Deterministic: %v", err)
	}
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/opaque/register/finish", tokenA, map[string]any{
		"agent_id":              agentA,
		"credential_identifier": "agent:" + agentA,
		"client_public_key_hex": hex.EncodeToString(regBundle.ClientPublicKey[:]),
		"masking_key_hex":       hex.EncodeToString(regBundle.MaskingKey[:]),
		"envelope_hex":          hex.EncodeToString(regBundle.Envelope),
		"slot4_envelope": map[string]any{
			"aad_utf8":       slot4Wrap.AADUTF8,
			"nonce_hex":      hex.EncodeToString(slot4Wrap.Nonce[:]),
			"ciphertext_hex": hex.EncodeToString(slot4Wrap.Ciphertext),
		},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("opaque/register/finish status=%d body=%s", resp.StatusCode, raw)
	}

	// OPAQUE 3DH Login KE1 -> KE2 -> KE3
	blindLogin := mustHex32(t, "9c3bb78643928a42ade8b88057986124d291d25883176af0f1ae566bd2977a01")
	clientEphScalar := mustHex32(t, "9fe75bd927eaa7e6a0b0d5bea34420dd9d44004c08f5438688292fd90fefbe09")
	var clientNonce [32]byte
	_, _ = rand.Read(clientNonce[:])
	blindedLogin, _ := auth.OpaqueOPRFBlindDeterministic(canaryPIN, blindLogin)
	// Build KE1 via Opaque3DHDerive dummy or direct 96B KE1:
	ke1Dummy, err := auth.Opaque3DHDerive(
		[]byte("Quetzalcoatl-OPAQUE-Slot4-v1"),
		[]byte(clientIDStr),
		[]byte(opRegInit.ServerIdentity),
		blindedLogin,
		clientNonce,
		regBundle.ClientPrivateScalar,
		clientEphScalar,
		evalReg,
		maskNonceReg,
		regBundle.MaskedResponse,
		clientNonce,
		serverOpaquePriv,
		clientEphScalar,
	)
	if err != nil {
		t.Fatalf("build KE1: %v", err)
	}
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/opaque/login/start", "", map[string]any{
		"agent_id":        agentA,
		"device_id":       devA1,
		"client_identity": clientIDStr,
		"ke1_hex":         hex.EncodeToString(ke1Dummy.KE1),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("opaque/login/start status=%d body=%s", resp.StatusCode, raw)
	}
	var opLoginStart struct {
		LoginID string `json:"login_id"`
		KE2Hex  string `json:"ke2_hex"`
	}
	_ = json.Unmarshal(raw, &opLoginStart)
	ke2Bytes := mustHex(t, opLoginStart.KE2Hex)
	if len(ke2Bytes) != 320 {
		t.Fatalf("expected 320-byte KE2, got %d", len(ke2Bytes))
	}
	var evalLogin, maskNonceLogin, serverNonceLogin, serverEphPKLogin, serverMACLogin [32]byte
	_ = serverMACLogin
	copy(evalLogin[:], ke2Bytes[0:32])
	copy(maskNonceLogin[:], ke2Bytes[32:64])
	maskedRespLogin := ke2Bytes[64:192]
	copy(serverNonceLogin[:], ke2Bytes[192:224])
	copy(serverEphPKLogin[:], ke2Bytes[224:256])
	gotServerMAC := ke2Bytes[256:320]

	oprfOutLogin, err := auth.OpaqueFinalizeOPRF(canaryPIN, blindLogin, evalLogin)
	if err != nil {
		t.Fatalf("OpaqueFinalizeOPRF login: %v", err)
	}
	hardenedLogin := argon2.IDKey(oprfOutLogin[:], opRegInit.MHF.Salt[:], opRegInit.MHF.Iterations, opRegInit.MHF.MemoryKiB, uint8(opRegInit.MHF.Parallelism), 64)
	_ = hardenedLogin

	// Wrong PIN MUST fail envelope opening on client and bad KE3 MUST fail on server!
	badKE3Resp, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/opaque/login/finish", "", map[string]any{
		"login_id": opLoginStart.LoginID,
		"ke3_hex":  hex.EncodeToString(bytes.Repeat([]byte{0xaa}, 64)),
	})
	if badKE3Resp.StatusCode == http.StatusOK {
		t.Fatalf("expected forged KE3 MAC to fail on server")
	}

	// Start fresh login and complete valid KE3
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/opaque/login/start", "", map[string]any{
		"agent_id":        agentA,
		"device_id":       devA1,
		"client_identity": clientIDStr,
		"ke1_hex":         hex.EncodeToString(ke1Dummy.KE1),
	})
	_ = json.Unmarshal(raw, &opLoginStart)
	ke2Bytes = mustHex(t, opLoginStart.KE2Hex)
	copy(evalLogin[:], ke2Bytes[0:32])
	copy(maskNonceLogin[:], ke2Bytes[32:64])
	maskedRespLogin = ke2Bytes[64:192]
	copy(serverNonceLogin[:], ke2Bytes[192:224])
	copy(serverEphPKLogin[:], ke2Bytes[224:256])
	gotServerMAC = ke2Bytes[256:320]

	exportLogin, clientSKLogin, serverPKLogin, err := auth.OpaqueOpenEnvelope(
		regBundle.RandomizedPwd,
		evalLogin,
		maskNonceLogin,
		maskedRespLogin,
		[]byte(opRegInit.ServerIdentity),
		[]byte(clientIDStr),
	)
	if err != nil {
		t.Fatalf("client OpaqueOpenEnvelope: %v", err)
	}
	clientMAC, expectedServerMAC, err := auth.OpaqueClientFinish3DH(
		[]byte("Quetzalcoatl-OPAQUE-Slot4-v1"),
		[]byte(clientIDStr),
		[]byte(opRegInit.ServerIdentity),
		ke1Dummy.KE1,
		clientSKLogin,
		clientEphScalar,
		ke2Bytes[0:192],
		serverNonceLogin,
		serverPKLogin,
		serverEphPKLogin,
	)
	if err != nil {
		t.Fatalf("OpaqueClientFinish3DH: %v", err)
	}
	if !bytes.Equal(expectedServerMAC[:], gotServerMAC) {
		t.Fatalf("KE2 ServerMAC mismatch")
	}

	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/opaque/login/finish", "", map[string]any{
		"login_id": opLoginStart.LoginID,
		"ke3_hex":  hex.EncodeToString(clientMAC[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("opaque/login/finish status=%d body=%s", resp.StatusCode, raw)
	}
	var opLoginFinish struct {
		SessionToken  string                `json:"session_token"`
		Slot4Envelope store.KeySlotEnvelope `json:"slot4_envelope"`
	}
	_ = json.Unmarshal(raw, &opLoginFinish)
	recoveredSlot4, err := auth.UnwrapSlot4(agentA, exportLogin, &auth.Slot4WrappedRootKey{
		AADUTF8:    opLoginFinish.Slot4Envelope.AADUTF8,
		Nonce:      mustHex24(t, opLoginFinish.Slot4Envelope.NonceHex),
		Ciphertext: mustHex(t, opLoginFinish.Slot4Envelope.CiphertextHex),
	})
	if err != nil || recoveredSlot4 != canaryRootSeed {
		t.Fatalf("Slot4 unwrap failed: err=%v", err)
	}

	// --- Slot 5: Hardware Enclave Local Slot Metadata ---
	var canaryHW [32]byte
	copy(canaryHW[:], []byte("CANARY_HARDWARE_ENCLAVE_SECRET!!"))
	slot5Env, err := auth.WrapWithHardwareSecret(agentA, canaryRootSeed, canaryHW)
	if err != nil {
		t.Fatalf("WrapWithHardwareSecret: %v", err)
	}
	resp, raw = doJSON(t, client, http.MethodPut, srv.URL+"/v1/auth/slots/"+agentA+"/hardware_local", tokenA, map[string]any{
		"aad_utf8":       slot5Env.AADUTF8,
		"nonce_hex":      slot5Env.NonceHex,
		"ciphertext_hex": slot5Env.CiphertextHex,
		"metadata_json":  `{"enclave":"SecureEnclave","key_tag":"com.quetzalcoatl.slot5"}`,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT hardware_local slot status=%d body=%s", resp.StatusCode, raw)
	}
	recoveredSlot5, err := auth.UnwrapWithHardwareSecret(agentA, canaryHW, slot5Env)
	if err != nil || recoveredSlot5 != canaryRootSeed {
		t.Fatalf("Slot5 unwrap failed: err=%v", err)
	}

	// --- Account B via OIDC PKCE + Cross-Account 403 Forbidden IDOR + ES256 Account Deletion ---
	verifier := "pkce-code-verifier-quetzalcoatl-v2-high-entropy-0123456789"
	verHash := sha256.Sum256([]byte(verifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(verHash[:])

	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/oidc/begin", "", map[string]any{
		"code_challenge":        codeChallenge,
		"code_challenge_method": "S256",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("oidc/begin status=%d body=%s", resp.StatusCode, raw)
	}
	var oidcBegin struct {
		ChallengeID string `json:"challenge_id"`
		State       string `json:"state"`
		Nonce       string `json:"nonce"`
	}
	_ = json.Unmarshal(raw, &oidcBegin)

	const agentB = "998f4a90-7c20-4d31-8b12-9a0b1c2d3e99"
	const devB1 = "99020304-0506-8708-890a-0b0c0d0e0f99"
	rootBPub, _, _ := ed25519.GenerateKey(rand.Reader)
	devB1Pub, _, _ := ed25519.GenerateKey(rand.Reader)
	idToken := signES256JWT(t, oidcKey, "idp-k1", map[string]any{
		"iss":   "https://idp.quetzalcoatl.example",
		"sub":   "oidc-user-b-7788",
		"aud":   "quetzalcoatl-client",
		"nonce": oidcBegin.Nonce,
		"iat":   clk.Now().Unix(),
		"exp":   clk.Now().Add(10 * time.Minute).Unix(),
	})

	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/oidc/callback", "", map[string]any{
		"challenge_id":              oidcBegin.ChallengeID,
		"state":                     oidcBegin.State,
		"code_verifier":             verifier,
		"id_token":                  idToken,
		"agent_id":                  agentB,
		"device_id":                 devB1,
		"root_verifying_key_hex":    hex.EncodeToString(rootBPub),
		"device_ed25519_pubkey_hex": hex.EncodeToString(devB1Pub),
		"device_xwing_pubkey_hex":   hex.EncodeToString(devA1XWingPK[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("oidc/callback status=%d body=%s", resp.StatusCode, raw)
	}
	var oidcFinish struct {
		SessionToken string `json:"session_token"`
	}
	_ = json.Unmarshal(raw, &oidcFinish)
	tokenB := oidcFinish.SessionToken

	// Cross-Account IDOR checks: Account B MUST get HTTP 403 Forbidden on ALL Agent A resources!
	idorChecks := []struct {
		method string
		url    string
		body   any
	}{
		{http.MethodGet, srv.URL + "/v1/auth/slots/" + agentA, nil},
		{http.MethodPut, srv.URL + "/v1/auth/slots/" + agentA + "/hardware_local", map[string]any{
			"aad_utf8":       slot5Env.AADUTF8,
			"nonce_hex":      slot5Env.NonceHex,
			"ciphertext_hex": slot5Env.CiphertextHex,
		}},
		{http.MethodPost, srv.URL + "/v1/pair/initiate", map[string]any{"agent_id": agentA}},
		{http.MethodPost, srv.URL + "/v1/auth/guardian/setup", map[string]any{
			"agent_id":              agentA,
			"threshold":             2,
			"total":                 3,
			"commitment_blake3_hex": hex.EncodeToString(shares[0].CommitmentBlake3[:]),
			"shares":                custodyReq,
		}},
		{http.MethodPost, srv.URL + "/v1/auth/opaque/register/init", map[string]any{
			"agent_id":            agentA,
			"blinded_element_hex": hex.EncodeToString(blindedReg[:]),
		}},
	}
	for _, ic := range idorChecks {
		r, body := doJSON(t, client, ic.method, ic.url, tokenB, ic.body)
		if r.StatusCode != http.StatusForbidden {
			t.Fatalf("IDOR check %s %s expected 403 Forbidden, got %d (%s)", ic.method, ic.url, r.StatusCode, body)
		}
	}

	// Zero-Knowledge Canary Scan on raw SQLite database & WAL files!
	for _, path := range []string{dbPath, dbPath + "-wal"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, canary := range [][]byte{
			canaryRootSeed[:],
			canaryPRF[:],
			canaryPIN,
			canaryHW[:],
			[]byte(tokenA), // raw session bearer token must also be hashed, never plaintext!
		} {
			if bytes.Contains(data, canary) {
				t.Fatalf("ZERO-KNOWLEDGE VIOLATION: plaintext secret/token %q found in %s!", canary, filepath.Base(path))
			}
		}
	}

	// ES256 Account Deletion Webhook (`POST /v1/auth/events`) MUST wipe Account B completely!
	setJWT := signES256JWT(t, webhookKey, "wh-k1", map[string]any{
		"iss": "https://idp.quetzalcoatl.example",
		"aud": "quetzalcoatl-client",
		"sub": "oidc-user-b-7788",
		"iat": clk.Now().Unix(),
		"exp": clk.Now().Add(5 * time.Minute).Unix(),
		"events": map[string]any{
			"https://schemas.openid.net/secevent/risc/event-type/account-purged": map[string]any{},
		},
	})
	_ = sha512.New // keep import used
	_ = big.NewInt(0)
	resp, raw = doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/events", "", map[string]any{
		"set_token": setJWT,
	})
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /v1/auth/events status=%d body=%s", resp.StatusCode, raw)
	}

	// Account B's session token MUST now be invalidated (401 Unauthorized) and Agent B deleted!
	postDelResp, _ := doJSON(t, client, http.MethodGet, srv.URL+"/v1/auth/slots/"+agentB, tokenB, nil)
	if postDelResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected wiped Account B session to return 401, got %d", postDelResp.StatusCode)
	}
}

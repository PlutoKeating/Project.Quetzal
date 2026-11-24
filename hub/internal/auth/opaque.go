// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"filippo.io/edwards25519"
	"github.com/gtank/ristretto255"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"quetzalcoatl-hub/internal/store"
)

const (
	oprfDSTHashToGroup   = "HashToGroup-OPRFV1-\x00-ristretto255-SHA512"
	slot4KDFInfo         = "Quetzalcoatl-Slot4-RootKeyWrap-v1"
	opaqueDefaultContext = "Quetzalcoatl-OPAQUE-Slot4-v1"
)

type OpaqueMhfParams struct {
	MemoryKiB   uint32   `json:"memory_kib"`
	Iterations  uint32   `json:"iterations"`
	Parallelism uint32   `json:"parallelism"`
	Salt        [16]byte `json:"-"`
	SaltHex     string   `json:"salt_hex"`
}

type OpaqueEnvelopeBundle struct {
	OPRFOutput           [64]byte
	HardenedOutput       [64]byte
	RandomizedPwd        [64]byte
	MaskingKey           [64]byte
	ExportKey            [64]byte
	AuthKey              [64]byte
	ClientPrivateScalar  [32]byte
	ClientPublicKey      [32]byte
	ServerPublicKey      [32]byte
	CleartextCredentials []byte
	EnvelopeNonce        [32]byte
	EnvelopeAuthTag      [64]byte
	Envelope             []byte
	MaskedResponse       []byte
}

type OpaqueAkeTranscript struct {
	KE1                []byte
	CredentialResponse []byte
	Preamble           []byte
	PreambleSHA512     [64]byte
	DHIKM              [96]byte
	PRK                [64]byte
	HandshakeSecret    [64]byte
	SessionKey         [64]byte
	KM2                [64]byte
	KM3                [64]byte
	ServerMAC          [64]byte
	ClientMAC          [64]byte
}

type Slot4WrappedRootKey struct {
	AADUTF8       string   `json:"aad_utf8"`
	Nonce         [24]byte `json:"-"`
	NonceHex      string   `json:"nonce_hex"`
	KEKDebugOnly  *[32]byte
	Ciphertext    []byte `json:"-"`
	CiphertextHex string `json:"ciphertext_hex"`
}

func expandMessageXMDSha512_64(msg, dst []byte) ([64]byte, error) {
	var out [64]byte
	if len(dst) > 255 {
		return out, errors.New("DST length exceeds 255")
	}
	dstPrime := make([]byte, 0, len(dst)+1)
	dstPrime = append(dstPrime, dst...)
	dstPrime = append(dstPrime, byte(len(dst)))

	h0 := sha512.New()
	var zeroBlock [128]byte
	_, _ = h0.Write(zeroBlock[:])
	_, _ = h0.Write(msg)
	var lenBytes [2]byte
	binary.BigEndian.PutUint16(lenBytes[:], 64)
	_, _ = h0.Write(lenBytes[:])
	_, _ = h0.Write([]byte{0})
	_, _ = h0.Write(dstPrime)
	b0 := h0.Sum(nil)

	h1 := sha512.New()
	_, _ = h1.Write(b0)
	_, _ = h1.Write([]byte{1})
	_, _ = h1.Write(dstPrime)
	copy(out[:], h1.Sum(nil))
	return out, nil
}

func oprfHashToRistretto(input []byte) (*ristretto255.Element, error) {
	uniform, err := expandMessageXMDSha512_64(input, []byte(oprfDSTHashToGroup))
	if err != nil {
		return nil, err
	}
	return ristretto255.NewIdentityElement().SetUniformBytes(uniform[:])
}

func decodeCanonicalRistrettoScalar(kind string, bytesLE [32]byte) (*ristretto255.Scalar, error) {
	// Verify canonical scalar encoding against both filippo.io/edwards25519 and ristretto255
	if _, err := edwards25519.NewScalar().SetCanonicalBytes(bytesLE[:]); err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: %s non-canonical scalar: %w", kind, err)
	}
	sc, err := ristretto255.NewScalar().SetCanonicalBytes(bytesLE[:])
	if err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: %s invalid ristretto scalar: %w", kind, err)
	}
	return sc, nil
}

func isZeroScalar(sc *ristretto255.Scalar) bool {
	return sc.Equal(ristretto255.NewScalar()) == 1
}

func decodeNonIdentityRistretto(kind string, bytes32 [32]byte) (*ristretto255.Element, error) {
	pt, err := ristretto255.NewIdentityElement().SetCanonicalBytes(bytes32[:])
	if err != nil {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: %s ristretto decode failed: %w", kind, err)
	}
	if pt.Equal(ristretto255.NewIdentityElement()) == 1 {
		return nil, fmt.Errorf("INTEGRITY_VIOLATION: %s cannot be identity element", kind)
	}
	return pt, nil
}

func hkdfExtractSHA512(salt, ikm []byte) ([64]byte, error) {
	var out [64]byte
	prk, err := hkdf.Extract(sha512.New, ikm, salt)
	if err != nil {
		return out, err
	}
	copy(out[:], prk)
	return out, nil
}

func hkdfExpandSHA512(prk [64]byte, info []byte, outLen int) ([]byte, error) {
	return hkdf.Expand(sha512.New, prk[:], string(info), outLen)
}

func hkdfExpandSHA512_64(prk [64]byte, info []byte) ([64]byte, error) {
	var out [64]byte
	b, err := hkdfExpandSHA512(prk, info, 64)
	if err != nil {
		return out, err
	}
	copy(out[:], b)
	return out, nil
}

func opaqueExpandLabel64(secret [64]byte, label, context []byte) ([64]byte, error) {
	var out [64]byte
	opaqueLabelLen := 7 + len(label)
	if opaqueLabelLen > 255 || len(context) > 255 {
		return out, errors.New("OPAQUE ExpandLabel length overflow")
	}
	custom := make([]byte, 0, 2+1+opaqueLabelLen+1+len(context))
	custom = append(custom, 0x00, 0x40) // uint16be(64)
	custom = append(custom, byte(opaqueLabelLen))
	custom = append(custom, "OPAQUE-"...)
	custom = append(custom, label...)
	custom = append(custom, byte(len(context)))
	custom = append(custom, context...)
	return hkdfExpandSHA512_64(secret, custom)
}

func appendU16Prefixed(buf []byte, item []byte) ([]byte, error) {
	if len(item) > 0xffff {
		return nil, errors.New("OPAQUE u16 field overflow")
	}
	var lenB [2]byte
	binary.BigEndian.PutUint16(lenB[:], uint16(len(item)))
	buf = append(buf, lenB[:]...)
	buf = append(buf, item...)
	return buf, nil
}

func buildCleartextCredentials(serverPK, clientPK [32]byte, serverIdentity, clientIdentity []byte) ([]byte, error) {
	effServer := serverIdentity
	if len(effServer) == 0 {
		effServer = serverPK[:]
	}
	effClient := clientIdentity
	if len(effClient) == 0 {
		effClient = clientPK[:]
	}
	out := make([]byte, 0, 32+2+len(effServer)+2+len(effClient))
	out = append(out, serverPK[:]...)
	var err error
	out, err = appendU16Prefixed(out, effServer)
	if err != nil {
		return nil, err
	}
	out, err = appendU16Prefixed(out, effClient)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func OpaqueOPRFBlindDeterministic(password []byte, blindScalarLE [32]byte) ([32]byte, error) {
	var out [32]byte
	blind, err := decodeCanonicalRistrettoScalar("blind_scalar", blindScalarLE)
	if err != nil {
		return out, err
	}
	if isZeroScalar(blind) {
		return out, errors.New("INTEGRITY_VIOLATION: zero blind scalar")
	}
	hPwd, err := oprfHashToRistretto(password)
	if err != nil {
		return out, err
	}
	blindedPt := ristretto255.NewIdentityElement().ScalarMult(blind, hPwd)
	if blindedPt.Equal(ristretto255.NewIdentityElement()) == 1 {
		return out, errors.New("INTEGRITY_VIOLATION: blinded element is identity")
	}
	copy(out[:], blindedPt.Bytes())
	return out, nil
}

func OpaqueEvaluateOPRF(blindedElement [32]byte, oprfKeyScalarLE [32]byte) ([32]byte, error) {
	var out [32]byte
	pt, err := decodeNonIdentityRistretto("blinded_element", blindedElement)
	if err != nil {
		return out, err
	}
	key, err := decodeCanonicalRistrettoScalar("oprf_key_scalar", oprfKeyScalarLE)
	if err != nil {
		return out, err
	}
	if isZeroScalar(key) {
		return out, errors.New("INTEGRITY_VIOLATION: zero OPRF key scalar")
	}
	evalPt := ristretto255.NewIdentityElement().ScalarMult(key, pt)
	copy(out[:], evalPt.Bytes())
	return out, nil
}

func OpaqueFinalizeOPRF(password []byte, blindScalarLE [32]byte, evaluatedElement [32]byte) ([64]byte, error) {
	var out [64]byte
	blind, err := decodeCanonicalRistrettoScalar("blind_scalar", blindScalarLE)
	if err != nil {
		return out, err
	}
	if isZeroScalar(blind) {
		return out, errors.New("INTEGRITY_VIOLATION: zero blind scalar")
	}
	evalPt, err := decodeNonIdentityRistretto("evaluated_element", evaluatedElement)
	if err != nil {
		return out, err
	}
	invBlind := ristretto255.NewScalar().Invert(blind)
	unblinded := ristretto255.NewIdentityElement().ScalarMult(invBlind, evalPt).Bytes()

	transcript := make([]byte, 0, 2+len(password)+2+32+8)
	transcript, err = appendU16Prefixed(transcript, password)
	if err != nil {
		return out, err
	}
	transcript, err = appendU16Prefixed(transcript, unblinded)
	if err != nil {
		return out, err
	}
	transcript = append(transcript, "Finalize"...)
	out = sha512.Sum512(transcript)
	return out, nil
}

func OpaqueBuildEnvelopeDeterministic(
	oprfOutput [64]byte,
	mhf OpaqueMhfParams,
	envelopeNonce [32]byte,
	maskingNonce [32]byte,
	serverPrivateScalarLE [32]byte,
	serverIdentity []byte,
	clientIdentity []byte,
) (*OpaqueEnvelopeBundle, error) {
	if mhf.Parallelism == 0 || mhf.Parallelism > 255 || mhf.Iterations == 0 || mhf.MemoryKiB == 0 {
		return nil, errors.New("invalid Argon2id MHF parameters")
	}
	hardenedSlice := argon2.IDKey(oprfOutput[:], mhf.Salt[:], mhf.Iterations, mhf.MemoryKiB, uint8(mhf.Parallelism), 64)
	var hardenedOutput [64]byte
	copy(hardenedOutput[:], hardenedSlice)

	var concat [128]byte
	copy(concat[0:64], oprfOutput[:])
	copy(concat[64:128], hardenedOutput[:])
	randomizedPwd, err := hkdfExtractSHA512(nil, concat[:])
	clear(concat[:])
	if err != nil {
		return nil, err
	}

	maskingKey, err := hkdfExpandSHA512_64(randomizedPwd, []byte("MaskingKey"))
	if err != nil {
		return nil, err
	}
	exportKey, err := hkdfExpandSHA512_64(randomizedPwd, append(append([]byte(nil), envelopeNonce[:]...), "ExportKey"...))
	if err != nil {
		return nil, err
	}
	authKey, err := hkdfExpandSHA512_64(randomizedPwd, append(append([]byte(nil), envelopeNonce[:]...), "AuthKey"...))
	if err != nil {
		return nil, err
	}
	privWide, err := hkdfExpandSHA512_64(randomizedPwd, append(append([]byte(nil), envelopeNonce[:]...), "PrivateKey"...))
	if err != nil {
		return nil, err
	}
	clientSK, err := ristretto255.NewScalar().SetUniformBytes(privWide[:])
	clear(privWide[:])
	if err != nil {
		return nil, err
	}
	var clientPrivScalar, clientPubKey, serverPubKey [32]byte
	copy(clientPrivScalar[:], clientSK.Bytes())
	copy(clientPubKey[:], ristretto255.NewIdentityElement().ScalarBaseMult(clientSK).Bytes())

	serverSK, err := decodeCanonicalRistrettoScalar("server_private_scalar", serverPrivateScalarLE)
	if err != nil {
		return nil, err
	}
	copy(serverPubKey[:], ristretto255.NewIdentityElement().ScalarBaseMult(serverSK).Bytes())

	cleartextCreds, err := buildCleartextCredentials(serverPubKey, clientPubKey, serverIdentity, clientIdentity)
	if err != nil {
		return nil, err
	}

	mac := hmac.New(sha512.New, authKey[:])
	_, _ = mac.Write(envelopeNonce[:])
	_, _ = mac.Write(cleartextCreds)
	var envAuthTag [64]byte
	copy(envAuthTag[:], mac.Sum(nil))

	envelope := make([]byte, 96)
	copy(envelope[0:32], envelopeNonce[:])
	copy(envelope[32:96], envAuthTag[:])

	padInfo := append(append([]byte(nil), maskingNonce[:]...), "CredentialResponsePad"...)
	pad, err := hkdfExpandSHA512(maskingKey, padInfo, 32+len(envelope))
	if err != nil {
		return nil, err
	}
	plainResp := make([]byte, 0, 32+len(envelope))
	plainResp = append(plainResp, serverPubKey[:]...)
	plainResp = append(plainResp, envelope...)

	maskedResp := make([]byte, len(plainResp))
	for i := range plainResp {
		maskedResp[i] = plainResp[i] ^ pad[i]
	}

	return &OpaqueEnvelopeBundle{
		OPRFOutput:           oprfOutput,
		HardenedOutput:       hardenedOutput,
		RandomizedPwd:        randomizedPwd,
		MaskingKey:           maskingKey,
		ExportKey:            exportKey,
		AuthKey:              authKey,
		ClientPrivateScalar:  clientPrivScalar,
		ClientPublicKey:      clientPubKey,
		ServerPublicKey:      serverPubKey,
		CleartextCredentials: cleartextCreds,
		EnvelopeNonce:        envelopeNonce,
		EnvelopeAuthTag:      envAuthTag,
		Envelope:             envelope,
		MaskedResponse:       maskedResp,
	}, nil
}

func OpaqueOpenEnvelope(
	randomizedPwd [64]byte,
	evaluatedElement [32]byte,
	maskingNonce [32]byte,
	maskedResponse []byte,
	serverIdentity []byte,
	clientIdentity []byte,
) ([64]byte, [32]byte, [32]byte, error) {
	var zero64 [64]byte
	var zero32 [32]byte
	if _, err := decodeNonIdentityRistretto("evaluated_element", evaluatedElement); err != nil {
		return zero64, zero32, zero32, err
	}
	if len(maskedResponse) != 128 {
		return zero64, zero32, zero32, errors.New("INTEGRITY_VIOLATION: masked_response length != 128")
	}
	maskingKey, err := hkdfExpandSHA512_64(randomizedPwd, []byte("MaskingKey"))
	if err != nil {
		return zero64, zero32, zero32, err
	}
	padInfo := append(append([]byte(nil), maskingNonce[:]...), "CredentialResponsePad"...)
	pad, err := hkdfExpandSHA512(maskingKey, padInfo, 128)
	if err != nil {
		return zero64, zero32, zero32, err
	}
	unmasked := make([]byte, 128)
	for i := 0; i < 128; i++ {
		unmasked[i] = maskedResponse[i] ^ pad[i]
	}
	var serverPK, envNonce [32]byte
	copy(serverPK[:], unmasked[0:32])
	copy(envNonce[:], unmasked[32:64])
	authTagSlice := unmasked[64:128]

	if _, err := decodeNonIdentityRistretto("server_public_key", serverPK); err != nil {
		return zero64, zero32, zero32, err
	}
	exportKey, err := hkdfExpandSHA512_64(randomizedPwd, append(append([]byte(nil), envNonce[:]...), "ExportKey"...))
	if err != nil {
		return zero64, zero32, zero32, err
	}
	authKey, err := hkdfExpandSHA512_64(randomizedPwd, append(append([]byte(nil), envNonce[:]...), "AuthKey"...))
	if err != nil {
		return zero64, zero32, zero32, err
	}
	privWide, err := hkdfExpandSHA512_64(randomizedPwd, append(append([]byte(nil), envNonce[:]...), "PrivateKey"...))
	if err != nil {
		return zero64, zero32, zero32, err
	}
	clientSK, err := ristretto255.NewScalar().SetUniformBytes(privWide[:])
	clear(privWide[:])
	if err != nil {
		return zero64, zero32, zero32, err
	}
	var clientPrivScalar, clientPK [32]byte
	copy(clientPrivScalar[:], clientSK.Bytes())
	copy(clientPK[:], ristretto255.NewIdentityElement().ScalarBaseMult(clientSK).Bytes())

	cleartextCreds, err := buildCleartextCredentials(serverPK, clientPK, serverIdentity, clientIdentity)
	if err != nil {
		return zero64, zero32, zero32, err
	}
	mac := hmac.New(sha512.New, authKey[:])
	_, _ = mac.Write(envNonce[:])
	_, _ = mac.Write(cleartextCreds)
	if !hmac.Equal(mac.Sum(nil), authTagSlice) {
		return zero64, zero32, zero32, errors.New("INTEGRITY_VIOLATION: OPAQUE envelope tag mismatch")
	}
	return exportKey, clientPrivScalar, serverPK, nil
}

func buildOpaquePreamble(
	context []byte,
	clientIdentity []byte,
	clientPK [32]byte,
	ke1 []byte,
	serverIdentity []byte,
	serverPK [32]byte,
	credentialResponse []byte,
	serverNonce [32]byte,
	serverEphPK [32]byte,
) ([]byte, [64]byte, error) {
	var zeroHash [64]byte
	effClient := clientIdentity
	if len(effClient) == 0 {
		effClient = clientPK[:]
	}
	effServer := serverIdentity
	if len(effServer) == 0 {
		effServer = serverPK[:]
	}
	var err error
	preamble := make([]byte, 0, 7+2+len(context)+2+len(effClient)+len(ke1)+2+len(effServer)+len(credentialResponse)+64)
	preamble = append(preamble, "RFC9807"...)
	preamble, err = appendU16Prefixed(preamble, context)
	if err != nil {
		return nil, zeroHash, err
	}
	preamble, err = appendU16Prefixed(preamble, effClient)
	if err != nil {
		return nil, zeroHash, err
	}
	preamble = append(preamble, ke1...)
	preamble, err = appendU16Prefixed(preamble, effServer)
	if err != nil {
		return nil, zeroHash, err
	}
	preamble = append(preamble, credentialResponse...)
	preamble = append(preamble, serverNonce[:]...)
	preamble = append(preamble, serverEphPK[:]...)
	return preamble, sha512.Sum512(preamble), nil
}

func Opaque3DHDerive(
	context []byte,
	clientIdentity []byte,
	serverIdentity []byte,
	blindedElement [32]byte,
	clientNonce [32]byte,
	clientPrivateScalarLE [32]byte,
	clientEphemeralScalarLE [32]byte,
	evaluatedElement [32]byte,
	maskingNonce [32]byte,
	maskedResponse []byte,
	serverNonce [32]byte,
	serverPrivateScalarLE [32]byte,
	serverEphemeralScalarLE [32]byte,
) (*OpaqueAkeTranscript, error) {
	clientSK, err := decodeCanonicalRistrettoScalar("client_private_scalar", clientPrivateScalarLE)
	if err != nil {
		return nil, err
	}
	clientEphSK, err := decodeCanonicalRistrettoScalar("client_ephemeral_scalar", clientEphemeralScalarLE)
	if err != nil {
		return nil, err
	}
	serverSK, err := decodeCanonicalRistrettoScalar("server_private_scalar", serverPrivateScalarLE)
	if err != nil {
		return nil, err
	}
	serverEphSK, err := decodeCanonicalRistrettoScalar("server_ephemeral_scalar", serverEphemeralScalarLE)
	if err != nil {
		return nil, err
	}

	var clientPK, clientEphPK, serverPK, serverEphPK [32]byte
	copy(clientPK[:], ristretto255.NewIdentityElement().ScalarBaseMult(clientSK).Bytes())
	clientEphPt := ristretto255.NewIdentityElement().ScalarBaseMult(clientEphSK)
	copy(clientEphPK[:], clientEphPt.Bytes())
	serverPt := ristretto255.NewIdentityElement().ScalarBaseMult(serverSK)
	copy(serverPK[:], serverPt.Bytes())
	serverEphPt := ristretto255.NewIdentityElement().ScalarBaseMult(serverEphSK)
	copy(serverEphPK[:], serverEphPt.Bytes())

	ke1 := make([]byte, 96)
	copy(ke1[0:32], blindedElement[:])
	copy(ke1[32:64], clientNonce[:])
	copy(ke1[64:96], clientEphPK[:])

	credResp := make([]byte, 0, 64+len(maskedResponse))
	credResp = append(credResp, evaluatedElement[:]...)
	credResp = append(credResp, maskingNonce[:]...)
	credResp = append(credResp, maskedResponse...)

	preamble, preambleHash, err := buildOpaquePreamble(context, clientIdentity, clientPK, ke1, serverIdentity, serverPK, credResp, serverNonce, serverEphPK)
	if err != nil {
		return nil, err
	}

	dh1 := ristretto255.NewIdentityElement().ScalarMult(clientEphSK, serverEphPt).Bytes()
	dh2 := ristretto255.NewIdentityElement().ScalarMult(clientEphSK, serverPt).Bytes()
	dh3 := ristretto255.NewIdentityElement().ScalarMult(clientSK, serverEphPt).Bytes()
	var dhIKM [96]byte
	copy(dhIKM[0:32], dh1)
	copy(dhIKM[32:64], dh2)
	copy(dhIKM[64:96], dh3)

	prk, err := hkdfExtractSHA512(nil, dhIKM[:])
	if err != nil {
		return nil, err
	}
	hs, err := opaqueExpandLabel64(prk, []byte("HandshakeSecret"), preambleHash[:])
	if err != nil {
		return nil, err
	}
	sessionKey, err := opaqueExpandLabel64(prk, []byte("SessionKey"), preambleHash[:])
	if err != nil {
		return nil, err
	}
	km2, err := opaqueExpandLabel64(hs, []byte("ServerMAC"), nil)
	if err != nil {
		return nil, err
	}
	km3, err := opaqueExpandLabel64(hs, []byte("ClientMAC"), nil)
	if err != nil {
		return nil, err
	}

	macS := hmac.New(sha512.New, km2[:])
	_, _ = macS.Write(preambleHash[:])
	var serverMAC [64]byte
	copy(serverMAC[:], macS.Sum(nil))

	h3 := sha512.New()
	_, _ = h3.Write(preamble)
	_, _ = h3.Write(serverMAC[:])
	t3Hash := h3.Sum(nil)

	macC := hmac.New(sha512.New, km3[:])
	_, _ = macC.Write(t3Hash)
	var clientMAC [64]byte
	copy(clientMAC[:], macC.Sum(nil))

	return &OpaqueAkeTranscript{
		KE1:                ke1,
		CredentialResponse: credResp,
		Preamble:           preamble,
		PreambleSHA512:     preambleHash,
		DHIKM:              dhIKM,
		PRK:                prk,
		HandshakeSecret:    hs,
		SessionKey:         sessionKey,
		KM2:                km2,
		KM3:                km3,
		ServerMAC:          serverMAC,
		ClientMAC:          clientMAC,
	}, nil
}

func OpaqueClientFinish3DH(
	context []byte,
	clientIdentity []byte,
	serverIdentity []byte,
	ke1 []byte,
	clientPrivateScalarLE [32]byte,
	clientEphemeralScalarLE [32]byte,
	credentialResponse []byte,
	serverNonce [32]byte,
	serverPublicKey [32]byte,
	serverEphemeralPK [32]byte,
) ([64]byte, [64]byte, error) {
	var zero [64]byte
	if len(ke1) != 96 || len(credentialResponse) != 192 {
		return zero, zero, errors.New("invalid KE1/credentialResponse length")
	}
	clientSK, err := decodeCanonicalRistrettoScalar("client_private_scalar", clientPrivateScalarLE)
	if err != nil {
		return zero, zero, err
	}
	clientEphSK, err := decodeCanonicalRistrettoScalar("client_ephemeral_scalar", clientEphemeralScalarLE)
	if err != nil {
		return zero, zero, err
	}
	serverPt, err := decodeNonIdentityRistretto("server_public_key", serverPublicKey)
	if err != nil {
		return zero, zero, err
	}
	serverEphPt, err := decodeNonIdentityRistretto("server_ephemeral_pk", serverEphemeralPK)
	if err != nil {
		return zero, zero, err
	}
	var clientPK [32]byte
	copy(clientPK[:], ristretto255.NewIdentityElement().ScalarBaseMult(clientSK).Bytes())

	preamble, preambleHash, err := buildOpaquePreamble(context, clientIdentity, clientPK, ke1, serverIdentity, serverPublicKey, credentialResponse, serverNonce, serverEphemeralPK)
	if err != nil {
		return zero, zero, err
	}
	var dhIKM [96]byte
	copy(dhIKM[0:32], ristretto255.NewIdentityElement().ScalarMult(clientEphSK, serverEphPt).Bytes())
	copy(dhIKM[32:64], ristretto255.NewIdentityElement().ScalarMult(clientEphSK, serverPt).Bytes())
	copy(dhIKM[64:96], ristretto255.NewIdentityElement().ScalarMult(clientSK, serverEphPt).Bytes())

	prk, err := hkdfExtractSHA512(nil, dhIKM[:])
	if err != nil {
		return zero, zero, err
	}
	hs, err := opaqueExpandLabel64(prk, []byte("HandshakeSecret"), preambleHash[:])
	if err != nil {
		return zero, zero, err
	}
	km2, err := opaqueExpandLabel64(hs, []byte("ServerMAC"), nil)
	if err != nil {
		return zero, zero, err
	}
	km3, err := opaqueExpandLabel64(hs, []byte("ClientMAC"), nil)
	if err != nil {
		return zero, zero, err
	}
	macS := hmac.New(sha512.New, km2[:])
	_, _ = macS.Write(preambleHash[:])
	var serverMAC [64]byte
	copy(serverMAC[:], macS.Sum(nil))

	h3 := sha512.New()
	_, _ = h3.Write(preamble)
	_, _ = h3.Write(serverMAC[:])
	macC := hmac.New(sha512.New, km3[:])
	_, _ = macC.Write(h3.Sum(nil))
	var clientMAC [64]byte
	copy(clientMAC[:], macC.Sum(nil))
	return clientMAC, serverMAC, nil
}

func WrapSlot4Deterministic(agentID string, opaqueExportKey [64]byte, rootSecret [32]byte, nonce [24]byte) (*Slot4WrappedRootKey, error) {
	kekSlice, err := hkdfExpandSHA512(opaqueExportKey, []byte(slot4KDFInfo), 32)
	if err != nil {
		return nil, err
	}
	var kek [32]byte
	copy(kek[:], kekSlice)
	clear(kekSlice)

	aad := canonicalSlotAAD(agentID, "opaque_pin")
	aead, err := chacha20poly1305.NewX(kek[:])
	if err != nil {
		return nil, err
	}
	ct := aead.Seal(nil, nonce[:], rootSecret[:], []byte(aad))
	kekCopy := kek
	return &Slot4WrappedRootKey{
		AADUTF8:       aad,
		Nonce:         nonce,
		NonceHex:      hex.EncodeToString(nonce[:]),
		KEKDebugOnly:  &kekCopy,
		Ciphertext:    ct,
		CiphertextHex: hex.EncodeToString(ct),
	}, nil
}

func UnwrapSlot4(agentID string, opaqueExportKey [64]byte, wrapped *Slot4WrappedRootKey) ([32]byte, error) {
	var out [32]byte
	expectedAAD := canonicalSlotAAD(agentID, "opaque_pin")
	if wrapped.AADUTF8 != expectedAAD {
		return out, errors.New("INTEGRITY_VIOLATION: Slot4 AAD mismatch")
	}
	kekSlice, err := hkdfExpandSHA512(opaqueExportKey, []byte(slot4KDFInfo), 32)
	if err != nil {
		return out, err
	}
	defer clear(kekSlice)
	aead, err := chacha20poly1305.NewX(kekSlice)
	if err != nil {
		return out, err
	}
	plain, err := aead.Open(nil, wrapped.Nonce[:], wrapped.Ciphertext, []byte(wrapped.AADUTF8))
	if err != nil {
		return out, errors.New("INTEGRITY_VIOLATION: Slot4 decryption failed")
	}
	defer clear(plain)
	if len(plain) != 32 {
		return out, errors.New("INTEGRITY_VIOLATION: Slot4 invalid plaintext length")
	}
	copy(out[:], plain)
	return out, nil
}

func (s *Service) deriveAgentOPRFScalar(agentID string) ([32]byte, error) {
	var out [32]byte
	prk, err := hkdfExtractSHA512(nil, s.cfg.OPRFMasterSeed[:])
	if err != nil {
		return out, err
	}
	wide, err := hkdfExpandSHA512_64(prk, []byte("Quetzalcoatl-OPRF-AgentScalar-v1:"+agentID))
	if err != nil {
		return out, err
	}
	sc, err := ristretto255.NewScalar().SetUniformBytes(wide[:])
	clear(wide[:])
	if err != nil {
		return out, err
	}
	copy(out[:], sc.Bytes())
	return out, nil
}

func (s *Service) deriveAgentMHFSalt(agentID string) ([16]byte, error) {
	var out [16]byte
	prk, err := hkdfExtractSHA512(nil, s.cfg.OPRFMasterSeed[:])
	if err != nil {
		return out, err
	}
	b, err := hkdfExpandSHA512(prk, []byte("Quetzalcoatl-MHF-Salt-v1:"+agentID), 16)
	if err != nil {
		return out, err
	}
	copy(out[:], b)
	return out, nil
}

func (s *Service) handleOpaqueRegisterInit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID           string `json:"agent_id"`
		BlindedElementHex string `json:"blinded_element_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	if _, _, ok := s.requireAgentOwner(w, r, req.AgentID); !ok {
		return
	}
	blinded, err := decodeHexFixed32(req.BlindedElementHex)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid blinded_element_hex")
		return
	}
	oprfScalar, err := s.deriveAgentOPRFScalar(req.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	evaluated, err := OpaqueEvaluateOPRF(blinded, oprfScalar)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	mhfSalt, err := s.deriveAgentMHFSalt(req.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"evaluated_element_hex": hex.EncodeToString(evaluated[:]),
		"server_public_key_hex": hex.EncodeToString(s.serverOpaquePubKey[:]),
		"server_identity":       s.cfg.ServerIdentity,
		"mhf": OpaqueMhfParams{
			MemoryKiB:   65536,
			Iterations:  3,
			Parallelism: 1,
			SaltHex:     hex.EncodeToString(mhfSalt[:]),
		},
	})
}

func (s *Service) handleOpaqueRegisterFinish(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID              string `json:"agent_id"`
		CredentialIdentifier string `json:"credential_identifier"`
		ClientPublicKeyHex   string `json:"client_public_key_hex"`
		MaskingKeyHex        string `json:"masking_key_hex"`
		EnvelopeHex          string `json:"envelope_hex"`
		Slot4Envelope        struct {
			AADUTF8       string `json:"aad_utf8"`
			NonceHex      string `json:"nonce_hex"`
			CiphertextHex string `json:"ciphertext_hex"`
		} `json:"slot4_envelope"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	principal, _, ok := s.requireAgentOwner(w, r, req.AgentID)
	if !ok {
		return
	}
	clientPK, err := decodeHexFixed32(req.ClientPublicKeyHex)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "invalid client_public_key_hex")
		return
	}
	if _, err := decodeNonIdentityRistretto("client_public_key", clientPK); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	maskBytes, err := hex.DecodeString(req.MaskingKeyHex)
	if err != nil || len(maskBytes) != 64 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "masking_key_hex must be 64 bytes")
		return
	}
	envBytes, err := hex.DecodeString(req.EnvelopeHex)
	if err != nil || len(envBytes) != 96 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "envelope_hex must be 96 bytes")
		return
	}
	if err := validateSymmetricSlotEnvelope(req.AgentID, "opaque_pin", req.Slot4Envelope.AADUTF8, req.Slot4Envelope.NonceHex, req.Slot4Envelope.CiphertextHex); err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}
	oprfScalar, err := s.deriveAgentOPRFScalar(req.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	if err := s.store.UpsertOpaqueRegistration(r.Context(), store.OpaqueRegistration{
		AgentID:              req.AgentID,
		AccountID:            principal.AccountID,
		CredentialIdentifier: req.CredentialIdentifier,
		ClientPublicKeyHex:   strings.ToLower(req.ClientPublicKeyHex),
		MaskingKeyHex:        strings.ToLower(req.MaskingKeyHex),
		EnvelopeHex:          strings.ToLower(req.EnvelopeHex),
		OPRFKeyScalarHex:     hex.EncodeToString(oprfScalar[:]),
		UpdatedAtMs:          nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := s.store.UpsertKeySlot(r.Context(), store.KeySlotEnvelope{
		AgentID:       req.AgentID,
		Slot:          "opaque_pin",
		AADUTF8:       req.Slot4Envelope.AADUTF8,
		NonceHex:      strings.ToLower(req.Slot4Envelope.NonceHex),
		CiphertextHex: strings.ToLower(req.Slot4Envelope.CiphertextHex),
		UpdatedAtMs:   nowMs,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "registered"})
}

func generateRandomRistrettoScalar() (*ristretto255.Scalar, [32]byte, error) {
	for {
		var wide [64]byte
		var out [32]byte
		if _, err := rand.Read(wide[:]); err != nil {
			return nil, out, err
		}
		sc, err := ristretto255.NewScalar().SetUniformBytes(wide[:])
		clear(wide[:])
		if err != nil {
			return nil, out, err
		}
		if isZeroScalar(sc) {
			continue
		}
		copy(out[:], sc.Bytes())
		return sc, out, nil
	}
}

// GenerateOpaqueServerScalar generates a cryptographically random canonical non-zero Ristretto255 scalar.
func GenerateOpaqueServerScalar() ([32]byte, error) {
	_, out, err := generateRandomRistrettoScalar()
	return out, err
}

// ValidateOpaqueServerScalar verifies bytesLE is a canonical non-zero Ristretto255 scalar.
func ValidateOpaqueServerScalar(bytesLE [32]byte) error {
	sc, err := decodeCanonicalRistrettoScalar("ServerOpaquePrivateScalar", bytesLE)
	if err != nil {
		return err
	}
	if isZeroScalar(sc) {
		return errors.New("ServerOpaquePrivateScalar cannot be zero")
	}
	return nil
}

func (s *Service) handleOpaqueLoginStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID        string `json:"agent_id"`
		DeviceID       string `json:"device_id"`
		ClientIdentity string `json:"client_identity"`
		KE1Hex         string `json:"ke1_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	ke1, err := hex.DecodeString(req.KE1Hex)
	if err != nil || len(ke1) != 96 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "KE1 must be 96 bytes")
		return
	}
	var blinded, clientEphPK [32]byte
	copy(blinded[:], ke1[0:32])
	copy(clientEphPK[:], ke1[64:96])

	clientEphPt, err := decodeNonIdentityRistretto("client_ephemeral_pk", clientEphPK)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}

	// Always evaluate OPRF before registration lookup to avoid timing side-channel enumeration
	derivedOPRFScalar, err := s.deriveAgentOPRFScalar(req.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	evaluated, err := OpaqueEvaluateOPRF(blinded, derivedOPRFScalar)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
		return
	}

	reg, err := s.store.GetOpaqueRegistration(r.Context(), req.AgentID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "opaque registration not found")
		return
	}
	if req.DeviceID != "" {
		dev, devErr := s.store.GetDevice(r.Context(), req.AgentID, req.DeviceID)
		if devErr != nil || dev.Revoked {
			writeAPIError(w, http.StatusForbidden, "PERMISSION_DENIED", "device is unregistered or revoked")
			return
		}
	}
	oprfScalar, err := decodeHexFixed32(reg.OPRFKeyScalarHex)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", "corrupt OPRF scalar")
		return
	}
	if oprfScalar != derivedOPRFScalar {
		evaluated, err = OpaqueEvaluateOPRF(blinded, oprfScalar)
		if err != nil {
			writeAPIError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", err.Error())
			return
		}
	}

	clientPK, err := decodeHexFixed32(reg.ClientPublicKeyHex)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", "corrupt client public key")
		return
	}
	clientStaticPt, err := decodeNonIdentityRistretto("client_public_key", clientPK)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	maskBytes, _ := hex.DecodeString(reg.MaskingKeyHex)
	var maskingKey [64]byte
	copy(maskingKey[:], maskBytes)
	envBytes, _ := hex.DecodeString(reg.EnvelopeHex)

	var maskingNonce, serverNonce [32]byte
	if _, err := rand.Read(maskingNonce[:]); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if _, err := rand.Read(serverNonce[:]); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	serverEphSK, _, err := generateRandomRistrettoScalar()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	var serverEphPK [32]byte
	copy(serverEphPK[:], ristretto255.NewIdentityElement().ScalarBaseMult(serverEphSK).Bytes())

	padInfo := append(append([]byte(nil), maskingNonce[:]...), "CredentialResponsePad"...)
	pad, err := hkdfExpandSHA512(maskingKey, padInfo, 128)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	plainResp := make([]byte, 128)
	copy(plainResp[0:32], s.serverOpaquePubKey[:])
	copy(plainResp[32:128], envBytes)
	maskedResp := make([]byte, 128)
	for i := 0; i < 128; i++ {
		maskedResp[i] = plainResp[i] ^ pad[i]
	}

	credResp := make([]byte, 192)
	copy(credResp[0:32], evaluated[:])
	copy(credResp[32:64], maskingNonce[:])
	copy(credResp[64:192], maskedResp)

	preamble, preambleHash, err := buildOpaquePreamble(
		[]byte(opaqueDefaultContext),
		[]byte(req.ClientIdentity),
		clientPK,
		ke1,
		[]byte(s.cfg.ServerIdentity),
		s.serverOpaquePubKey,
		credResp,
		serverNonce,
		serverEphPK,
	)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", err.Error())
		return
	}

	// Server 3DH: DH1 = server_eph_sk * client_eph_pk, DH2 = server_static_sk * client_eph_pk, DH3 = server_eph_sk * client_static_pk
	var dhIKM [96]byte
	copy(dhIKM[0:32], ristretto255.NewIdentityElement().ScalarMult(serverEphSK, clientEphPt).Bytes())
	copy(dhIKM[32:64], ristretto255.NewIdentityElement().ScalarMult(s.serverOpaqueScalar, clientEphPt).Bytes())
	copy(dhIKM[64:96], ristretto255.NewIdentityElement().ScalarMult(serverEphSK, clientStaticPt).Bytes())

	prk, err := hkdfExtractSHA512(nil, dhIKM[:])
	clear(dhIKM[:])
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	hs, err := opaqueExpandLabel64(prk, []byte("HandshakeSecret"), preambleHash[:])
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	km2, err := opaqueExpandLabel64(hs, []byte("ServerMAC"), nil)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	km3, err := opaqueExpandLabel64(hs, []byte("ClientMAC"), nil)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	macS := hmac.New(sha512.New, km2[:])
	_, _ = macS.Write(preambleHash[:])
	serverMAC := macS.Sum(nil)

	loginID, err := randomIDHex(16)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	nowMs := s.clock().UnixMilli()
	if err := s.store.SaveOpaqueLoginState(r.Context(), store.OpaqueLoginState{
		LoginID:      loginID,
		AgentID:      req.AgentID,
		AccountID:    reg.AccountID,
		DeviceID:     req.DeviceID,
		KM3Hex:       hex.EncodeToString(km3[:]),
		PreambleHex:  hex.EncodeToString(preamble),
		ServerMACHex: hex.EncodeToString(serverMAC),
		ExpiresAtMs:  nowMs + 2*60*1000,
	}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}

	ke2 := make([]byte, 0, 320)
	ke2 = append(ke2, credResp...)
	ke2 = append(ke2, serverNonce[:]...)
	ke2 = append(ke2, serverEphPK[:]...)
	ke2 = append(ke2, serverMAC...)
	writeJSON(w, http.StatusOK, map[string]string{
		"login_id": loginID,
		"ke2_hex":  hex.EncodeToString(ke2),
	})
}

func (s *Service) handleOpaqueLoginFinish(w http.ResponseWriter, r *http.Request) {
	var req struct {
		LoginID string `json:"login_id"`
		KE3Hex  string `json:"ke3_hex"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "SERIALIZATION_ERROR", err.Error())
		return
	}
	ke3, err := hex.DecodeString(req.KE3Hex)
	if err != nil || len(ke3) != 64 {
		writeAPIError(w, http.StatusBadRequest, "INVALID_ID", "KE3 must be 64 bytes")
		return
	}
	nowMs := s.clock().UnixMilli()
	st, err := s.store.ConsumeOpaqueLoginState(r.Context(), req.LoginID, nowMs)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "opaque login session invalid or expired")
		return
	}
	km3Bytes, _ := hex.DecodeString(st.KM3Hex)
	preambleBytes, _ := hex.DecodeString(st.PreambleHex)
	serverMACBytes, _ := hex.DecodeString(st.ServerMACHex)

	h3 := sha512.New()
	_, _ = h3.Write(preambleBytes)
	_, _ = h3.Write(serverMACBytes)
	macC := hmac.New(sha512.New, km3Bytes)
	_, _ = macC.Write(h3.Sum(nil))
	if !hmac.Equal(macC.Sum(nil), ke3) {
		writeAPIError(w, http.StatusUnauthorized, "CREDENTIAL_REJECTED", "OPAQUE KE3 client MAC verification failed")
		return
	}

	slot4, err := s.store.GetKeySlot(r.Context(), st.AgentID, "opaque_pin")
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "STORAGE_ERROR", "slot4 envelope missing")
		return
	}
	rawToken, err := s.issueSession(r.Context(), st.AccountID, st.AgentID, st.DeviceID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_token":  rawToken,
		"account_id":     st.AccountID,
		"agent_id":       st.AgentID,
		"device_id":      st.DeviceID,
		"slot4_envelope": slot4,
	})
}

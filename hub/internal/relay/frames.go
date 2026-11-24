// SPDX-License-Identifier: AGPL-3.0-only

package relay

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"time"
	"unicode/utf8"

	"filippo.io/edwards25519"
	"lukechampine.com/blake3"
)

var (
	ErrNotImplemented       = errors.New("not implemented")
	ErrFrameTooLarge        = errors.New("frame exceeds MAX_PACKET_SIZE")
	ErrInvalidFrame         = errors.New("invalid relay frame")
	ErrInvalidPublicKey     = errors.New("invalid ed25519 public key")
	ErrFrameNotAllowedInVer = errors.New("frame not allowed in negotiated protocol version")
	ErrUnknownFrameType     = errors.New("unknown relay frame type")
	ErrSignatureInvalid     = errors.New("client signature invalid")
	ErrKeyMaterialMismatch  = errors.New("tls exported keying material mismatch")
	ErrNoKeyingMaterial     = errors.New("no tls keying material available")
)

const (
	MaxPacketSize           = 64 * 1024
	MaxWSFrameSize          = 1024 * 1024
	ClientAuthHeader        = "X-Iroh-Relay-Client-Auth-V1"
	DomainSepChallenge      = "iroh-relay handshake v1 challenge signature"
	DomainSepTLSExportLabel = "iroh-relay handshake v1"
)

type ProtocolVersion uint8

const (
	ProtocolV1 ProtocolVersion = 1
	ProtocolV2 ProtocolVersion = 2
)

func (v ProtocolVersion) String() string {
	switch v {
	case ProtocolV1:
		return "iroh-relay-v1"
	case ProtocolV2:
		return "iroh-relay-v2"
	default:
		return ""
	}
}

func ParseProtocolVersion(s string) (ProtocolVersion, bool) {
	switch s {
	case "iroh-relay-v2":
		return ProtocolV2, true
	case "iroh-relay-v1":
		return ProtocolV1, true
	default:
		return 0, false
	}
}

type FrameType uint32

const (
	FrameServerChallenge            FrameType = 0
	FrameClientAuth                 FrameType = 1
	FrameServerConfirmsAuth         FrameType = 2
	FrameServerDeniesAuth           FrameType = 3
	FrameClientToRelayDatagram      FrameType = 4
	FrameClientToRelayDatagramBatch FrameType = 5
	FrameRelayToClientDatagram      FrameType = 6
	FrameRelayToClientDatagramBatch FrameType = 7
	FrameEndpointGone               FrameType = 8
	FramePing                       FrameType = 9
	FramePong                       FrameType = 10
	FrameHealth                     FrameType = 11
	FrameRestarting                 FrameType = 12
	FrameStatus                     FrameType = 13
)

type Status uint8

const (
	StatusHealthy                 Status = 0
	StatusSameEndpointIDConnected Status = 1
	StatusRateLimited             Status = 2
)

func (s Status) ProblemString() string {
	switch s {
	case StatusHealthy:
		return "The connection is healthy and has recovered from previous problems"
	case StatusSameEndpointIDConnected:
		return "Another endpoint connected with the same endpoint id. No more messages will be received."
	case StatusRateLimited:
		return "The relay is rate-limiting this endpoint; outbound relay traffic is being throttled."
	default:
		return "Unsupported health message"
	}
}

type KeyMaterialClientAuth struct {
	PublicKey         [32]byte
	Signature         [64]byte
	KeyMaterialSuffix [16]byte
}

type ServerChallenge struct {
	Challenge [16]byte
}

type ClientAuth struct {
	PublicKey [32]byte
	Signature [64]byte
}

type ServerDeniesAuth struct {
	Reason string
}

type Datagrams struct {
	ECN         uint8
	HasBatch    bool
	SegmentSize uint16
	Contents    []byte
}

type ClientToRelayMsg struct {
	Type          FrameType
	DstEndpointID [32]byte
	Datagrams     Datagrams
	PingPong      [8]byte
}

type RelayToClientMsg struct {
	Type             FrameType
	RemoteEndpointID [32]byte
	Datagrams        Datagrams
	GoneEndpointID   [32]byte
	PingPong         [8]byte
	HealthProblem    string
	ReconnectIn      time.Duration
	TryFor           time.Duration
	Status           Status
}

// --- QUIC RFC 9000 VarInt helpers ---

func AppendQuicVarInt(dst []byte, v uint64) []byte {
	switch {
	case v < (1 << 6):
		return append(dst, byte(v))
	case v < (1 << 14):
		return append(dst, byte(0x40|(v>>8)), byte(v))
	case v < (1 << 30):
		return append(dst, byte(0x80|(v>>24)), byte(v>>16), byte(v>>8), byte(v))
	default:
		v &= (1 << 62) - 1
		return append(dst,
			byte(0xc0|(v>>56)),
			byte(v>>48),
			byte(v>>40),
			byte(v>>32),
			byte(v>>24),
			byte(v>>16),
			byte(v>>8),
			byte(v),
		)
	}
}

func ReadQuicVarInt(src []byte) (uint64, int, error) {
	if len(src) == 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	length := 1 << (src[0] >> 6)
	if len(src) < length {
		return 0, 0, io.ErrUnexpectedEOF
	}
	val := uint64(src[0] & 0x3f)
	for i := 1; i < length; i++ {
		val = (val << 8) | uint64(src[i])
	}
	return val, length, nil
}

// --- Postcard ULEB128 helpers (for handshake frames 0..=3) ---

func appendULEB128(dst []byte, v uint64) []byte {
	for v >= 0x80 {
		dst = append(dst, byte(v)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

func readULEB128(src []byte) (uint64, int, error) {
	var x uint64
	var s uint
	for i, b := range src {
		if i >= 10 {
			return 0, 0, ErrInvalidFrame
		}
		if b < 0x80 {
			if i == 9 && b > 1 {
				return 0, 0, ErrInvalidFrame
			}
			return x | uint64(b)<<s, i + 1, nil
		}
		x |= uint64(b&0x7f) << s
		s += 7
	}
	return 0, 0, ErrInvalidFrame
}

func ValidateEndpointID(pk [32]byte) error {
	if _, err := new(edwards25519.Point).SetBytes(pk[:]); err != nil {
		return ErrInvalidPublicKey
	}
	return nil
}

func readFrameType(buf []byte) (FrameType, []byte, error) {
	v, n, err := ReadQuicVarInt(buf)
	if err != nil {
		return 0, nil, ErrInvalidFrame
	}
	if v > uint64(FrameStatus) {
		return 0, nil, ErrUnknownFrameType
	}
	return FrameType(v), buf[n:], nil
}

// --- Handshake messages (0..=3 + x-iroh-relay-client-auth-v1) ---

func ChallengeSigningMessage(challenge [16]byte) [32]byte {
	var out [32]byte
	blake3.DeriveKey(out[:], DomainSepChallenge, challenge[:])
	return out
}

func VerifyClientAuth(ca ClientAuth, ch ServerChallenge) error {
	if err := ValidateEndpointID(ca.PublicKey); err != nil {
		return err
	}
	msg := ChallengeSigningMessage(ch.Challenge)
	if !ed25519.Verify(ed25519.PublicKey(ca.PublicKey[:]), msg[:], ca.Signature[:]) {
		return ErrSignatureInvalid
	}
	return nil
}

func VerifyKeyMaterialClientAuth(
	km KeyMaterialClientAuth,
	exportFn func(label string, context []byte, length int) ([]byte, error),
) error {
	if err := ValidateEndpointID(km.PublicKey); err != nil {
		return err
	}
	if exportFn == nil {
		return ErrNoKeyingMaterial
	}
	keyMat, err := exportFn(DomainSepTLSExportLabel, km.PublicKey[:], 32)
	if err != nil || len(keyMat) != 32 {
		return ErrNoKeyingMaterial
	}
	msg := keyMat[:16]
	suffix := keyMat[16:32]
	if subtle.ConstantTimeCompare(suffix, km.KeyMaterialSuffix[:]) != 1 {
		return ErrKeyMaterialMismatch
	}
	if !ed25519.Verify(ed25519.PublicKey(km.PublicKey[:]), msg, km.Signature[:]) {
		return ErrSignatureInvalid
	}
	return nil
}

func EncodeServerChallenge(ch ServerChallenge) []byte {
	out := make([]byte, 0, 17)
	out = AppendQuicVarInt(out, uint64(FrameServerChallenge))
	out = append(out, ch.Challenge[:]...)
	return out
}

func DecodeServerChallenge(frame []byte) (ServerChallenge, error) {
	var out ServerChallenge
	ft, rest, err := readFrameType(frame)
	if err != nil {
		return out, err
	}
	if ft != FrameServerChallenge || len(rest) != 16 {
		return out, ErrInvalidFrame
	}
	copy(out.Challenge[:], rest)
	return out, nil
}

func EncodeClientAuth(ca ClientAuth) []byte {
	out := make([]byte, 0, 98)
	out = AppendQuicVarInt(out, uint64(FrameClientAuth))
	out = append(out, ca.PublicKey[:]...)
	out = appendULEB128(out, 64) // serde_bytes length prefix (0x40)
	out = append(out, ca.Signature[:]...)
	return out
}

func DecodeClientAuth(frame []byte) (ClientAuth, error) {
	var out ClientAuth
	ft, rest, err := readFrameType(frame)
	if err != nil {
		return out, err
	}
	if ft != FrameClientAuth || len(rest) < 32 {
		return out, ErrInvalidFrame
	}
	copy(out.PublicKey[:], rest[:32])
	if err := ValidateEndpointID(out.PublicKey); err != nil {
		return out, err
	}
	rest = rest[32:]
	sigLen, n, err := readULEB128(rest)
	if err != nil || sigLen != 64 || len(rest)-n != 64 {
		return out, ErrInvalidFrame
	}
	copy(out.Signature[:], rest[n:n+64])
	return out, nil
}

func EncodeServerConfirmsAuth() []byte {
	return AppendQuicVarInt(make([]byte, 0, 1), uint64(FrameServerConfirmsAuth))
}

func DecodeServerConfirmsAuth(frame []byte) error {
	ft, rest, err := readFrameType(frame)
	if err != nil {
		return err
	}
	if ft != FrameServerConfirmsAuth || len(rest) != 0 {
		return ErrInvalidFrame
	}
	return nil
}

func EncodeServerDeniesAuth(reason string) []byte {
	out := make([]byte, 0, 1+5+len(reason))
	out = AppendQuicVarInt(out, uint64(FrameServerDeniesAuth))
	out = appendULEB128(out, uint64(len(reason)))
	out = append(out, reason...)
	return out
}

func DecodeServerDeniesAuth(frame []byte) (ServerDeniesAuth, error) {
	var out ServerDeniesAuth
	ft, rest, err := readFrameType(frame)
	if err != nil {
		return out, err
	}
	if ft != FrameServerDeniesAuth {
		return out, ErrInvalidFrame
	}
	sLen, n, err := readULEB128(rest)
	if err != nil || sLen > uint64(len(rest)-n) || int(sLen) != len(rest)-n {
		return out, ErrInvalidFrame
	}
	reasonBytes := rest[n : n+int(sLen)]
	if !utf8.Valid(reasonBytes) {
		return out, ErrInvalidFrame
	}
	out.Reason = string(reasonBytes)
	return out, nil
}

func EncodeKeyMaterialClientAuthHeader(km KeyMaterialClientAuth) string {
	buf := make([]byte, 0, 113)
	buf = append(buf, km.PublicKey[:]...)
	buf = appendULEB128(buf, 64)
	buf = append(buf, km.Signature[:]...)
	buf = append(buf, km.KeyMaterialSuffix[:]...)
	return base64.RawURLEncoding.EncodeToString(buf)
}

func DecodeKeyMaterialClientAuthHeader(hdr string) (KeyMaterialClientAuth, error) {
	var out KeyMaterialClientAuth
	raw, err := base64.RawURLEncoding.DecodeString(hdr)
	if err != nil || len(raw) < 32+1+64+16 {
		return out, ErrInvalidFrame
	}
	copy(out.PublicKey[:], raw[:32])
	if err := ValidateEndpointID(out.PublicKey); err != nil {
		return out, err
	}
	rest := raw[32:]
	sigLen, n, err := readULEB128(rest)
	if err != nil || sigLen != 64 || len(rest)-n != 64+16 {
		return out, ErrInvalidFrame
	}
	copy(out.Signature[:], rest[n:n+64])
	copy(out.KeyMaterialSuffix[:], rest[n+64:n+80])
	return out, nil
}

// --- Relay data/control frames (4..=13) ---

func encodeDatagrams(dst []byte, d Datagrams, isBatch bool) []byte {
	dst = append(dst, d.ECN&0x03)
	if isBatch {
		var seg [2]byte
		binary.BigEndian.PutUint16(seg[:], d.SegmentSize)
		dst = append(dst, seg[:]...)
	}
	dst = append(dst, d.Contents...)
	return dst
}

func decodeDatagrams(src []byte, isBatch bool) (Datagrams, error) {
	if isBatch {
		if len(src) < 3 {
			return Datagrams{}, ErrInvalidFrame
		}
		seg := binary.BigEndian.Uint16(src[1:3])
		return Datagrams{
			ECN:         src[0] & 0x03,
			HasBatch:    seg > 0,
			SegmentSize: seg,
			Contents:    append([]byte(nil), src[3:]...),
		}, nil
	}
	if len(src) < 1 {
		return Datagrams{}, ErrInvalidFrame
	}
	return Datagrams{
		ECN:      src[0] & 0x03,
		Contents: append([]byte(nil), src[1:]...),
	}, nil
}

func EncodeClientToRelayMsg(msg ClientToRelayMsg) ([]byte, error) {
	switch msg.Type {
	case FrameClientToRelayDatagram, FrameClientToRelayDatagramBatch:
		isBatch := msg.Type == FrameClientToRelayDatagramBatch || (msg.Datagrams.HasBatch && msg.Datagrams.SegmentSize > 0)
		ft := FrameClientToRelayDatagram
		if isBatch {
			ft = FrameClientToRelayDatagramBatch
		}
		out := make([]byte, 0, 1+32+3+len(msg.Datagrams.Contents))
		out = AppendQuicVarInt(out, uint64(ft))
		out = append(out, msg.DstEndpointID[:]...)
		out = encodeDatagrams(out, msg.Datagrams, isBatch)
		if len(out) > MaxPacketSize {
			return nil, ErrFrameTooLarge
		}
		return out, nil
	case FramePing, FramePong:
		out := make([]byte, 0, 9)
		out = AppendQuicVarInt(out, uint64(msg.Type))
		out = append(out, msg.PingPong[:]...)
		return out, nil
	default:
		return nil, ErrInvalidFrame
	}
}

func DecodeClientToRelayMsg(frame []byte) (ClientToRelayMsg, error) {
	var out ClientToRelayMsg
	if len(frame) > MaxPacketSize {
		return out, ErrFrameTooLarge
	}
	ft, rest, err := readFrameType(frame)
	if err != nil {
		return out, err
	}
	out.Type = ft
	switch ft {
	case FrameClientToRelayDatagram, FrameClientToRelayDatagramBatch:
		if len(rest) < 32 {
			return out, ErrInvalidFrame
		}
		copy(out.DstEndpointID[:], rest[:32])
		if err := ValidateEndpointID(out.DstEndpointID); err != nil {
			return out, err
		}
		dg, err := decodeDatagrams(rest[32:], ft == FrameClientToRelayDatagramBatch)
		if err != nil {
			return out, err
		}
		out.Datagrams = dg
		return out, nil
	case FramePing, FramePong:
		if len(rest) != 8 {
			return out, ErrInvalidFrame
		}
		copy(out.PingPong[:], rest)
		return out, nil
	default:
		return out, ErrInvalidFrame
	}
}

func EncodeRelayToClientMsg(msg RelayToClientMsg, ver ProtocolVersion) ([]byte, error) {
	switch msg.Type {
	case FrameRelayToClientDatagram, FrameRelayToClientDatagramBatch:
		isBatch := msg.Type == FrameRelayToClientDatagramBatch || (msg.Datagrams.HasBatch && msg.Datagrams.SegmentSize > 0)
		ft := FrameRelayToClientDatagram
		if isBatch {
			ft = FrameRelayToClientDatagramBatch
		}
		out := make([]byte, 0, 1+32+3+len(msg.Datagrams.Contents))
		out = AppendQuicVarInt(out, uint64(ft))
		out = append(out, msg.RemoteEndpointID[:]...)
		out = encodeDatagrams(out, msg.Datagrams, isBatch)
		if len(out)-1 > MaxPacketSize {
			return nil, ErrFrameTooLarge
		}
		return out, nil
	case FrameEndpointGone:
		out := make([]byte, 0, 33)
		out = AppendQuicVarInt(out, uint64(FrameEndpointGone))
		out = append(out, msg.GoneEndpointID[:]...)
		return out, nil
	case FramePing, FramePong:
		out := make([]byte, 0, 9)
		out = AppendQuicVarInt(out, uint64(msg.Type))
		out = append(out, msg.PingPong[:]...)
		return out, nil
	case FrameHealth:
		if ver >= ProtocolV2 {
			return nil, ErrFrameNotAllowedInVer
		}
		out := make([]byte, 0, 1+len(msg.HealthProblem))
		out = AppendQuicVarInt(out, uint64(FrameHealth))
		out = append(out, msg.HealthProblem...)
		return out, nil
	case FrameRestarting:
		out := make([]byte, 0, 9)
		out = AppendQuicVarInt(out, uint64(FrameRestarting))
		recMs := msg.ReconnectIn.Milliseconds()
		if recMs < 0 {
			recMs = 0
		} else if recMs > math.MaxUint32 {
			recMs = math.MaxUint32
		}
		tryMs := msg.TryFor.Milliseconds()
		if tryMs < 0 {
			tryMs = 0
		} else if tryMs > math.MaxUint32 {
			tryMs = math.MaxUint32
		}
		var b8 [8]byte
		binary.BigEndian.PutUint32(b8[0:4], uint32(recMs))
		binary.BigEndian.PutUint32(b8[4:8], uint32(tryMs))
		out = append(out, b8[:]...)
		return out, nil
	case FrameStatus:
		if ver == ProtocolV1 {
			return nil, ErrFrameNotAllowedInVer
		}
		out := make([]byte, 0, 2)
		out = AppendQuicVarInt(out, uint64(FrameStatus))
		out = append(out, byte(msg.Status))
		return out, nil
	default:
		return nil, ErrInvalidFrame
	}
}

func DecodeRelayToClientMsg(frame []byte, ver ProtocolVersion) (RelayToClientMsg, error) {
	var out RelayToClientMsg
	ft, rest, err := readFrameType(frame)
	if err != nil {
		return out, err
	}
	if len(rest) > MaxPacketSize {
		return out, ErrFrameTooLarge
	}
	out.Type = ft
	switch ft {
	case FrameRelayToClientDatagram, FrameRelayToClientDatagramBatch:
		if len(rest) < 32 {
			return out, ErrInvalidFrame
		}
		copy(out.RemoteEndpointID[:], rest[:32])
		if err := ValidateEndpointID(out.RemoteEndpointID); err != nil {
			return out, err
		}
		dg, err := decodeDatagrams(rest[32:], ft == FrameRelayToClientDatagramBatch)
		if err != nil {
			return out, err
		}
		out.Datagrams = dg
		return out, nil
	case FrameEndpointGone:
		if len(rest) != 32 {
			return out, ErrInvalidFrame
		}
		copy(out.GoneEndpointID[:], rest)
		if err := ValidateEndpointID(out.GoneEndpointID); err != nil {
			return out, err
		}
		return out, nil
	case FramePing, FramePong:
		if len(rest) != 8 {
			return out, ErrInvalidFrame
		}
		copy(out.PingPong[:], rest)
		return out, nil
	case FrameHealth:
		if ver >= ProtocolV2 {
			return out, ErrFrameNotAllowedInVer
		}
		if !utf8.Valid(rest) {
			return out, ErrInvalidFrame
		}
		out.HealthProblem = string(rest)
		return out, nil
	case FrameRestarting:
		if len(rest) != 8 {
			return out, ErrInvalidFrame
		}
		recMs := binary.BigEndian.Uint32(rest[0:4])
		tryMs := binary.BigEndian.Uint32(rest[4:8])
		out.ReconnectIn = time.Duration(recMs) * time.Millisecond
		out.TryFor = time.Duration(tryMs) * time.Millisecond
		return out, nil
	case FrameStatus:
		if ver == ProtocolV1 {
			return out, ErrFrameNotAllowedInVer
		}
		if len(rest) < 1 {
			return out, ErrInvalidFrame
		}
		out.Status = Status(rest[0])
		return out, nil
	default:
		return out, ErrInvalidFrame
	}
}

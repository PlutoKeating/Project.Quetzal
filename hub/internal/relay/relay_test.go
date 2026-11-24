// SPDX-License-Identifier: AGPL-3.0-only

package relay_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/chacha20poly1305"
	"lukechampine.com/blake3"
	"quetzalcoatl-hub/internal/relay"
)

func mustDecodeHexSpaced(t *testing.T, raw string) []byte {
	t.Helper()
	var cleaned strings.Builder
	for _, r := range raw {
		if r != ' ' && r != '\n' && r != '\t' && r != '\r' {
			cleaned.WriteRune(r)
		}
	}
	b, err := hex.DecodeString(cleaned.String())
	if err != nil {
		t.Fatalf("decode hex %q: %v", raw, err)
	}
	return b
}

func keypairFromByte(seedByte byte) (ed25519.PrivateKey, [32]byte) {
	seed := bytes.Repeat([]byte{seedByte}, 32)
	priv := ed25519.NewKeyFromSeed(seed)
	var pub [32]byte
	copy(pub[:], priv.Public().(ed25519.PublicKey))
	return priv, pub
}

func TestGoldenFramesV2AndV1(t *testing.T) {
	priv42, pub42 := keypairFromByte(42)
	expectedPub42 := mustDecodeHexSpaced(t, "19 7f 6b 23 e1 6c 85 32 c6 ab c8 38 fa cd 5e a7 89 be 0c 76 b2 92 03 34 03 9b fa 8b 3d 36 8d 61")
	if !bytes.Equal(pub42[:], expectedPub42) {
		t.Fatalf("seed 42 pubkey mismatch: got %x want %x", pub42, expectedPub42)
	}

	// 0: ServerChallenge (0x00 || 16B challenge)
	var chBytes [16]byte
	for i := range chBytes {
		chBytes[i] = byte(i + 1)
	}
	encCh := relay.EncodeServerChallenge(relay.ServerChallenge{Challenge: chBytes})
	if len(encCh) != 17 || encCh[0] != 0x00 || !bytes.Equal(encCh[1:], chBytes[:]) {
		t.Fatalf("ServerChallenge wire mismatch: got %x", encCh)
	}
	decCh, err := relay.DecodeServerChallenge(encCh)
	if err != nil || decCh.Challenge != chBytes {
		t.Fatalf("DecodeServerChallenge failed: ch=%v err=%v", decCh, err)
	}

	// 1: ClientAuth (0x01 || 32B pubkey || 0x40 || 64B sig)
	var expectedMsg [32]byte
	blake3.DeriveKey(expectedMsg[:], relay.DomainSepChallenge, chBytes[:])
	gotMsg := relay.ChallengeSigningMessage(chBytes)
	if gotMsg != expectedMsg {
		t.Fatalf("ChallengeSigningMessage mismatch: got %x want %x", gotMsg, expectedMsg)
	}
	sig := ed25519.Sign(priv42, expectedMsg[:])
	var sig64 [64]byte
	copy(sig64[:], sig)
	encCA := relay.EncodeClientAuth(relay.ClientAuth{PublicKey: pub42, Signature: sig64})
	if len(encCA) != 98 || encCA[0] != 0x01 || encCA[33] != 0x40 || !bytes.Equal(encCA[1:33], pub42[:]) || !bytes.Equal(encCA[34:], sig64[:]) {
		t.Fatalf("ClientAuth wire mismatch (len=%d): %x", len(encCA), encCA)
	}
	decCA, err := relay.DecodeClientAuth(encCA)
	if err != nil || decCA.PublicKey != pub42 || decCA.Signature != sig64 {
		t.Fatalf("DecodeClientAuth failed: err=%v", err)
	}

	// KeyMaterialClientAuth header: BASE64URL_NOPAD(32B pk || 0x40 || 64B sig || 16B suffix) -> 113 raw bytes
	var suffix16 [16]byte
	copy(suffix16[:], "0123456789abcdef")
	hdrVal := relay.EncodeKeyMaterialClientAuthHeader(relay.KeyMaterialClientAuth{
		PublicKey:         pub42,
		Signature:         sig64,
		KeyMaterialSuffix: suffix16,
	})
	rawKM, err := base64.RawURLEncoding.DecodeString(hdrVal)
	if err != nil || len(rawKM) != 113 || rawKM[32] != 0x40 {
		t.Fatalf("KeyMaterialClientAuth postcard bytes mismatch: len=%d err=%v", len(rawKM), err)
	}
	decKM, err := relay.DecodeKeyMaterialClientAuthHeader(hdrVal)
	if err != nil || decKM.PublicKey != pub42 || decKM.Signature != sig64 || decKM.KeyMaterialSuffix != suffix16 {
		t.Fatalf("DecodeKeyMaterialClientAuthHeader failed: err=%v", err)
	}

	// 2: ServerConfirmsAuth ([0x02])
	encConf := relay.EncodeServerConfirmsAuth()
	if !bytes.Equal(encConf, []byte{0x02}) {
		t.Fatalf("ServerConfirmsAuth mismatch: got %x", encConf)
	}
	if err := relay.DecodeServerConfirmsAuth(encConf); err != nil {
		t.Fatalf("DecodeServerConfirmsAuth failed: %v", err)
	}

	// 3: ServerDeniesAuth (0x03 || uleb128(len) || utf8)
	reason := strings.Repeat("signature invalid! ", 10) // 190 bytes -> 2-byte ULEB128 (0xbe, 0x01)
	encDeny := relay.EncodeServerDeniesAuth(reason)
	if len(encDeny) != 1+2+len(reason) || encDeny[0] != 0x03 || encDeny[1] != 0xbe || encDeny[2] != 0x01 {
		t.Fatalf("ServerDeniesAuth postcard ULEB128 mismatch: len=%d prefix=%x", len(encDeny), encDeny[:min(6, len(encDeny))])
	}
	decDeny, err := relay.DecodeServerDeniesAuth(encDeny)
	if err != nil || decDeny.Reason != reason {
		t.Fatalf("DecodeServerDeniesAuth failed: got %q err=%v", decDeny.Reason, err)
	}

	// Golden snapshots from upstream iroh-relay 1.5.0 relay.rs tests
	var ping42 [8]byte
	for i := range ping42 {
		ping42[i] = 42
	}

	clientGolden := []struct {
		name string
		msg  relay.ClientToRelayMsg
		hex  string
	}{
		{
			name: "ClientPing",
			msg:  relay.ClientToRelayMsg{Type: relay.FramePing, PingPong: ping42},
			hex:  "09 2a 2a 2a 2a 2a 2a 2a 2a",
		},
		{
			name: "ClientPong",
			msg:  relay.ClientToRelayMsg{Type: relay.FramePong, PingPong: ping42},
			hex:  "0a 2a 2a 2a 2a 2a 2a 2a 2a",
		},
		{
			name: "ClientToRelayDatagramBatch",
			msg: relay.ClientToRelayMsg{
				Type:          relay.FrameClientToRelayDatagramBatch,
				DstEndpointID: pub42,
				Datagrams: relay.Datagrams{
					ECN:         0x03,
					HasBatch:    true,
					SegmentSize: 6,
					Contents:    []byte("Hello World!"),
				},
			},
			hex: `05
				19 7f 6b 23 e1 6c 85 32 c6 ab c8 38 fa cd 5e a7
				89 be 0c 76 b2 92 03 34 03 9b fa 8b 3d 36 8d 61
				03
				00 06
				48 65 6c 6c 6f 20 57 6f 72 6c 64 21`,
		},
		{
			name: "ClientToRelayDatagram",
			msg: relay.ClientToRelayMsg{
				Type:          relay.FrameClientToRelayDatagram,
				DstEndpointID: pub42,
				Datagrams: relay.Datagrams{
					ECN:      0x03,
					Contents: []byte("Hello World!"),
				},
			},
			hex: `04
				19 7f 6b 23 e1 6c 85 32 c6 ab c8 38 fa cd 5e a7
				89 be 0c 76 b2 92 03 34 03 9b fa 8b 3d 36 8d 61
				03
				48 65 6c 6c 6f 20 57 6f 72 6c 64 21`,
		},
	}

	for _, tc := range clientGolden {
		want := mustDecodeHexSpaced(t, tc.hex)
		got, err := relay.EncodeClientToRelayMsg(tc.msg)
		if err != nil {
			t.Fatalf("%s encode error: %v", tc.name, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s golden mismatch:\ngot:  %x\nwant: %x", tc.name, got, want)
		}
		roundtrip, err := relay.DecodeClientToRelayMsg(got)
		if err != nil {
			t.Fatalf("%s decode error: %v", tc.name, err)
		}
		if roundtrip.Type != tc.msg.Type || roundtrip.DstEndpointID != tc.msg.DstEndpointID || roundtrip.PingPong != tc.msg.PingPong || !bytes.Equal(roundtrip.Datagrams.Contents, tc.msg.Datagrams.Contents) {
			t.Fatalf("%s roundtrip mismatch: %+v", tc.name, roundtrip)
		}
	}

	serverGolden := []struct {
		name string
		ver  relay.ProtocolVersion
		msg  relay.RelayToClientMsg
		hex  string
	}{
		{
			name: "HealthV1",
			ver:  relay.ProtocolV1,
			msg: relay.RelayToClientMsg{
				Type:          relay.FrameHealth,
				HealthProblem: "Hello? Yes this is dog.",
			},
			hex: "0b 48 65 6c 6c 6f 3f 20 59 65 73 20 74 68 69 73 20 69 73 20 64 6f 67 2e",
		},
		{
			name: "EndpointGone",
			ver:  relay.ProtocolV2,
			msg: relay.RelayToClientMsg{
				Type:           relay.FrameEndpointGone,
				GoneEndpointID: pub42,
			},
			hex: `08 19 7f 6b 23 e1 6c 85 32 c6 ab c8 38 fa cd 5e
				a7 89 be 0c 76 b2 92 03 34 03 9b fa 8b 3d 36 8d 61`,
		},
		{
			name: "ServerPing",
			ver:  relay.ProtocolV2,
			msg:  relay.RelayToClientMsg{Type: relay.FramePing, PingPong: ping42},
			hex:  "09 2a 2a 2a 2a 2a 2a 2a 2a",
		},
		{
			name: "ServerPong",
			ver:  relay.ProtocolV2,
			msg:  relay.RelayToClientMsg{Type: relay.FramePong, PingPong: ping42},
			hex:  "0a 2a 2a 2a 2a 2a 2a 2a 2a",
		},
		{
			name: "RelayToClientDatagramBatch",
			ver:  relay.ProtocolV2,
			msg: relay.RelayToClientMsg{
				Type:             relay.FrameRelayToClientDatagramBatch,
				RemoteEndpointID: pub42,
				Datagrams: relay.Datagrams{
					ECN:         0x03,
					HasBatch:    true,
					SegmentSize: 6,
					Contents:    []byte("Hello World!"),
				},
			},
			hex: `07
				19 7f 6b 23 e1 6c 85 32 c6 ab c8 38 fa cd 5e a7
				89 be 0c 76 b2 92 03 34 03 9b fa 8b 3d 36 8d 61
				03
				00 06
				48 65 6c 6c 6f 20 57 6f 72 6c 64 21`,
		},
		{
			name: "RelayToClientDatagram",
			ver:  relay.ProtocolV2,
			msg: relay.RelayToClientMsg{
				Type:             relay.FrameRelayToClientDatagram,
				RemoteEndpointID: pub42,
				Datagrams: relay.Datagrams{
					ECN:      0x03,
					Contents: []byte("Hello World!"),
				},
			},
			hex: `06
				19 7f 6b 23 e1 6c 85 32 c6 ab c8 38 fa cd 5e a7
				89 be 0c 76 b2 92 03 34 03 9b fa 8b 3d 36 8d 61
				03
				48 65 6c 6c 6f 20 57 6f 72 6c 64 21`,
		},
		{
			name: "Restarting",
			ver:  relay.ProtocolV2,
			msg: relay.RelayToClientMsg{
				Type:        relay.FrameRestarting,
				ReconnectIn: 10 * time.Millisecond,
				TryFor:      20 * time.Millisecond,
			},
			hex: "0c 00 00 00 0a 00 00 00 14",
		},
		{
			name: "StatusHealthy",
			ver:  relay.ProtocolV2,
			msg:  relay.RelayToClientMsg{Type: relay.FrameStatus, Status: relay.StatusHealthy},
			hex:  "0d 00",
		},
		{
			name: "StatusSameEndpointIdConnected",
			ver:  relay.ProtocolV2,
			msg:  relay.RelayToClientMsg{Type: relay.FrameStatus, Status: relay.StatusSameEndpointIDConnected},
			hex:  "0d 01",
		},
		{
			name: "StatusRateLimited",
			ver:  relay.ProtocolV2,
			msg:  relay.RelayToClientMsg{Type: relay.FrameStatus, Status: relay.StatusRateLimited},
			hex:  "0d 02",
		},
	}

	for _, tc := range serverGolden {
		want := mustDecodeHexSpaced(t, tc.hex)
		got, err := relay.EncodeRelayToClientMsg(tc.msg, tc.ver)
		if err != nil {
			t.Fatalf("%s encode error: %v", tc.name, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s golden mismatch:\ngot:  %x\nwant: %x", tc.name, got, want)
		}
		roundtrip, err := relay.DecodeRelayToClientMsg(got, tc.ver)
		if err != nil {
			t.Fatalf("%s decode error: %v", tc.name, err)
		}
		if roundtrip.Type != tc.msg.Type {
			t.Fatalf("%s roundtrip type mismatch: got %v want %v", tc.name, roundtrip.Type, tc.msg.Type)
		}
	}

	// Version gates: Health(11) forbidden in v2, Status(13) forbidden in v1
	if _, err := relay.DecodeRelayToClientMsg([]byte{0x0b, 'x'}, relay.ProtocolV2); !errors.Is(err, relay.ErrFrameNotAllowedInVer) {
		t.Fatalf("expected Health rejected in v2, got %v", err)
	}
	if _, err := relay.DecodeRelayToClientMsg([]byte{0x0d, 0x01}, relay.ProtocolV1); !errors.Is(err, relay.ErrFrameNotAllowedInVer) {
		t.Fatalf("expected Status rejected in v1, got %v", err)
	}

	// Undersized and oversized datagram rejections
	if _, err := relay.DecodeClientToRelayMsg([]byte{0x04}); !errors.Is(err, relay.ErrInvalidFrame) {
		t.Fatalf("expected undersized datagram rejected, got %v", err)
	}
	oversized := make([]byte, relay.MaxPacketSize+1)
	oversized[0] = 0x04
	copy(oversized[1:33], pub42[:])
	if _, err := relay.DecodeClientToRelayMsg(oversized); !errors.Is(err, relay.ErrFrameTooLarge) {
		t.Fatalf("expected FrameTooLarge, got %v", err)
	}
}

// --- Minimal RFC 6455 test client for verifying exact wire behavior ---

type testWSClient struct {
	conn     net.Conn
	rw       *bufio.ReadWriter
	protocol string
	tlsState *tls.ConnectionState
}

func dialTestWS(t *testing.T, rawURL string, subprotocols string, extraHeaders http.Header, tlsCfg *tls.Config) *testWSClient {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	var rawConn net.Conn
	var cs *tls.ConnectionState
	if u.Scheme == "wss" || u.Scheme == "https" {
		c, err := tls.Dial("tcp", u.Host, tlsCfg)
		if err != nil {
			t.Fatalf("tls dial: %v", err)
		}
		state := c.ConnectionState()
		cs = &state
		rawConn = c
	} else {
		c, err := net.Dial("tcp", u.Host)
		if err != nil {
			t.Fatalf("tcp dial: %v", err)
		}
		rawConn = c
	}

	// Compute x-iroh-relay-client-auth-v1 dynamically if requested via callback marker
	if extraHeaders != nil && extraHeaders.Get("X-Test-Sign-TLS-Export-Seed") != "" && cs != nil {
		seedHex := extraHeaders.Get("X-Test-Sign-TLS-Export-Seed")
		extraHeaders.Del("X-Test-Sign-TLS-Export-Seed")
		seedBytes, _ := hex.DecodeString(seedHex)
		priv := ed25519.NewKeyFromSeed(seedBytes)
		var pub [32]byte
		copy(pub[:], priv.Public().(ed25519.PublicKey))
		ekm, err := cs.ExportKeyingMaterial(relay.DomainSepTLSExportLabel, pub[:], 32)
		if err != nil {
			t.Fatalf("client ExportKeyingMaterial: %v", err)
		}
		var sig64 [64]byte
		copy(sig64[:], ed25519.Sign(priv, ekm[:16]))
		var suffix [16]byte
		copy(suffix[:], ekm[16:32])
		extraHeaders.Set(relay.ClientAuthHeader, relay.EncodeKeyMaterialClientAuthHeader(relay.KeyMaterialClientAuth{
			PublicKey:         pub,
			Signature:         sig64,
			KeyMaterialSuffix: suffix,
		}))
	}

	var keyRaw [16]byte
	_, _ = rand.Read(keyRaw[:])
	wsKey := base64.StdEncoding.EncodeToString(keyRaw[:])

	path := u.RequestURI()
	req, err := http.NewRequest("GET", "http://"+u.Host+path, nil)
	if err != nil {
		t.Fatalf("new req: %v", err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", wsKey)
	if subprotocols != "" {
		req.Header.Set("Sec-WebSocket-Protocol", subprotocols)
	}
	for k, vals := range extraHeaders {
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}

	rw := bufio.NewReadWriter(bufio.NewReader(rawConn), bufio.NewWriter(rawConn))
	if err := req.Write(rw); err != nil {
		_ = rawConn.Close()
		t.Fatalf("write upgrade req: %v", err)
	}
	if err := rw.Flush(); err != nil {
		_ = rawConn.Close()
		t.Fatalf("flush upgrade req: %v", err)
	}
	resp, err := http.ReadResponse(rw.Reader, req)
	if err != nil {
		_ = rawConn.Close()
		t.Fatalf("read upgrade resp: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(resp.Body)
		_ = rawConn.Close()
		t.Fatalf("expected 101 Switching Protocols, got %d (%s)", resp.StatusCode, string(body))
	}
	h := sha1.New()
	_, _ = h.Write([]byte(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	wantAccept := base64.StdEncoding.EncodeToString(h.Sum(nil))
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != wantAccept {
		_ = rawConn.Close()
		t.Fatalf("Sec-WebSocket-Accept mismatch: got %q want %q", got, wantAccept)
	}

	return &testWSClient{
		conn:     rawConn,
		rw:       rw,
		protocol: resp.Header.Get("Sec-WebSocket-Protocol"),
		tlsState: cs,
	}
}

func (c *testWSClient) writeBinary(t *testing.T, payload []byte) {
	t.Helper()
	_ = c.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	var hdr []byte
	hdr = append(hdr, 0x82) // FIN=1, opcode=2 (binary)
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n <= 65535:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		var l8 [8]byte
		binary.BigEndian.PutUint64(l8[:], uint64(n))
		hdr = append(hdr, 0x80|127)
		hdr = append(hdr, l8[:]...)
	}
	hdr = append(hdr, mask[:]...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.rw.Write(hdr); err != nil {
		t.Fatalf("ws write hdr: %v", err)
	}
	if _, err := c.rw.Write(masked); err != nil {
		t.Fatalf("ws write payload: %v", err)
	}
	if err := c.rw.Flush(); err != nil {
		t.Fatalf("ws flush: %v", err)
	}
}

func (c *testWSClient) readBinary(t *testing.T) ([]byte, error) {
	t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		var b2 [2]byte
		if _, err := io.ReadFull(c.rw, b2[:]); err != nil {
			return nil, err
		}
		opcode := b2[0] & 0x0f
		masked := (b2[1] & 0x80) != 0
		length := uint64(b2[1] & 0x7f)
		switch length {
		case 126:
			var l2 [2]byte
			if _, err := io.ReadFull(c.rw, l2[:]); err != nil {
				return nil, err
			}
			length = uint64(binary.BigEndian.Uint16(l2[:]))
		case 127:
			var l8 [8]byte
			if _, err := io.ReadFull(c.rw, l8[:]); err != nil {
				return nil, err
			}
			length = binary.BigEndian.Uint64(l8[:])
		}
		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(c.rw, maskKey[:]); err != nil {
				return nil, err
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.rw, payload); err != nil {
			return nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i%4]
			}
		}
		if opcode == 0x8 { // Close
			return nil, io.EOF
		}
		if opcode == 0x9 { // Ping -> ignore or continue in test
			continue
		}
		if opcode == 0x2 {
			return payload, nil
		}
	}
}

func (c *testWSClient) close() {
	_ = c.conn.Close()
}

func TestWSRelayHandshakeTLSExporterAndReverseProxyFallback(t *testing.T) {
	srv := relay.NewServer(relay.Config{WriteTimeout: 2 * time.Second, QueueDepth: 64})
	defer func() { _ = srv.Close() }()

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	tlsHTTP := httptest.NewUnstartedServer(mux)
	tlsHTTP.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	tlsHTTP.StartTLS()
	defer tlsHTTP.Close()

	// 1. Latency probe GET /ping & captive portal GET /generate_204
	httpClient := tlsHTTP.Client()
	pingResp, err := httpClient.Get(tlsHTTP.URL + "/ping")
	if err != nil {
		t.Fatalf("GET /ping error: %v", err)
	}
	_ = pingResp.Body.Close()
	if pingResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /ping status: got %d want 200", pingResp.StatusCode)
	}

	// 2. Native TLS 1.3 fast-path via x-iroh-relay-client-auth-v1 (0-RTT challenge skipped!)
	seedA := bytes.Repeat([]byte{0x11}, 32)
	hdrFast := make(http.Header)
	hdrFast.Set("X-Test-Sign-TLS-Export-Seed", hex.EncodeToString(seedA))
	wsFast := dialTestWS(t, tlsHTTP.URL+"/relay", "iroh-relay-v1, iroh-relay-v2", hdrFast, &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS13,
	})
	defer wsFast.close()
	if wsFast.protocol != "iroh-relay-v2" {
		t.Fatalf("expected negotiated protocol iroh-relay-v2, got %q", wsFast.protocol)
	}
	firstFrame, err := wsFast.readBinary(t)
	if err != nil {
		t.Fatalf("read fast-path auth confirmation: %v", err)
	}
	if !bytes.Equal(firstFrame, []byte{0x02}) {
		t.Fatalf("expected immediate ServerConfirmsAuth [0x02] on matching TLS exporter, got %x", firstFrame)
	}

	// 3. Reverse-proxy TLS Exporter mismatch -> graceful fallback to ServerChallenge + blake3::derive_key!
	privB, pubB := keypairFromByte(0x22)
	var fakeProxyEKM [16]byte
	copy(fakeProxyEKM[:], "proxy-mismatch!!")
	var fakeSig [64]byte
	copy(fakeSig[:], ed25519.Sign(privB, []byte("proxy-outer-tls!")))
	hdrProxy := make(http.Header)
	hdrProxy.Set(relay.ClientAuthHeader, relay.EncodeKeyMaterialClientAuthHeader(relay.KeyMaterialClientAuth{
		PublicKey:         pubB,
		Signature:         fakeSig,
		KeyMaterialSuffix: fakeProxyEKM,
	}))
	wsFallback := dialTestWS(t, tlsHTTP.URL+"/relay", "iroh-relay-v2", hdrProxy, &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS13,
	})
	defer wsFallback.close()
	chFrame, err := wsFallback.readBinary(t)
	if err != nil {
		t.Fatalf("expected ServerChallenge fallback frame, got err: %v", err)
	}
	ch, err := relay.DecodeServerChallenge(chFrame)
	if err != nil {
		t.Fatalf("decode ServerChallenge fallback: %v (raw=%x)", err, chFrame)
	}
	signInput := relay.ChallengeSigningMessage(ch.Challenge)
	var validSig [64]byte
	copy(validSig[:], ed25519.Sign(privB, signInput[:]))
	wsFallback.writeBinary(t, relay.EncodeClientAuth(relay.ClientAuth{
		PublicKey: pubB,
		Signature: validSig,
	}))
	confFrame, err := wsFallback.readBinary(t)
	if err != nil || !bytes.Equal(confFrame, []byte{0x02}) {
		t.Fatalf("expected ServerConfirmsAuth [0x02] after challenge fallback, got %x err=%v", confFrame, err)
	}

	// 4. Invalid signature -> ServerDeniesAuth [0x03, len, reason] and close!
	_, pubBad := keypairFromByte(0x33)
	wsBad := dialTestWS(t, tlsHTTP.URL+"/relay", "iroh-relay-v2", nil, &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS13,
	})
	defer wsBad.close()
	chBadRaw, err := wsBad.readBinary(t)
	if err != nil {
		t.Fatalf("read challenge for bad client: %v", err)
	}
	if _, err := relay.DecodeServerChallenge(chBadRaw); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	var badSig [64]byte
	wsBad.writeBinary(t, relay.EncodeClientAuth(relay.ClientAuth{
		PublicKey: pubBad,
		Signature: badSig,
	}))
	denyRaw, err := wsBad.readBinary(t)
	if err != nil {
		t.Fatalf("expected ServerDeniesAuth frame, got err: %v", err)
	}
	deny, err := relay.DecodeServerDeniesAuth(denyRaw)
	if err != nil || deny.Reason == "" {
		t.Fatalf("expected non-empty ServerDeniesAuth reason, got %+v err=%v", deny, err)
	}
}

func authenticateChallengeWS(t *testing.T, baseURL string, priv ed25519.PrivateKey, pub [32]byte) *testWSClient {
	t.Helper()
	ws := dialTestWS(t, baseURL+"/relay", "iroh-relay-v2", nil, nil)
	chRaw, err := ws.readBinary(t)
	if err != nil {
		ws.close()
		t.Fatalf("read challenge: %v", err)
	}
	ch, err := relay.DecodeServerChallenge(chRaw)
	if err != nil {
		ws.close()
		t.Fatalf("decode challenge: %v", err)
	}
	msg := relay.ChallengeSigningMessage(ch.Challenge)
	var sig [64]byte
	copy(sig[:], ed25519.Sign(priv, msg[:]))
	ws.writeBinary(t, relay.EncodeClientAuth(relay.ClientAuth{PublicKey: pub, Signature: sig}))
	conf, err := ws.readBinary(t)
	if err != nil || !bytes.Equal(conf, []byte{0x02}) {
		ws.close()
		t.Fatalf("expected ServerConfirmsAuth [0x02], got %x err=%v", conf, err)
	}
	return ws
}

func TestWSRelayDatagramForwardingDuplicateEndpointAndEndpointGone(t *testing.T) {
	srv := relay.NewServer(relay.Config{WriteTimeout: 2 * time.Second, QueueDepth: 64})
	defer func() { _ = srv.Close() }()

	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)
	httpSrv := httptest.NewServer(mux)
	defer httpSrv.Close()

	privA, pubA := keypairFromByte(0x41)
	privB, pubB := keypairFromByte(0x42)

	wsA1 := authenticateChallengeWS(t, httpSrv.URL, privA, pubA)
	defer wsA1.close()
	wsB := authenticateChallengeWS(t, httpSrv.URL, privB, pubB)
	defer wsB.close()

	// Ping (0x09) -> Pong (0x0a)
	var pingPayload [8]byte
	copy(pingPayload[:], "qz-ping!")
	pingBytes, err := relay.EncodeClientToRelayMsg(relay.ClientToRelayMsg{
		Type:     relay.FramePing,
		PingPong: pingPayload,
	})
	if err != nil {
		t.Fatalf("encode ping: %v", err)
	}
	wsA1.writeBinary(t, pingBytes)
	pongRaw, err := wsA1.readBinary(t)
	if err != nil {
		t.Fatalf("read pong: %v", err)
	}
	pongMsg, err := relay.DecodeRelayToClientMsg(pongRaw, relay.ProtocolV2)
	if err != nil || pongMsg.Type != relay.FramePong || pongMsg.PingPong != pingPayload {
		t.Fatalf("unexpected pong: %+v err=%v", pongMsg, err)
	}

	// Single Datagram (0x04 -> 0x06) and Batch Datagram (0x05 -> 0x07) from A1 to B
	dgramBytes, err := relay.EncodeClientToRelayMsg(relay.ClientToRelayMsg{
		Type:          relay.FrameClientToRelayDatagram,
		DstEndpointID: pubB,
		Datagrams: relay.Datagrams{
			ECN:      0x02,
			Contents: []byte("quic-packet-1"),
		},
	})
	if err != nil {
		t.Fatalf("encode dgram: %v", err)
	}
	wsA1.writeBinary(t, dgramBytes)

	gotDgramRaw, err := wsB.readBinary(t)
	if err != nil {
		t.Fatalf("B read dgram: %v", err)
	}
	gotDgram, err := relay.DecodeRelayToClientMsg(gotDgramRaw, relay.ProtocolV2)
	if err != nil || gotDgram.Type != relay.FrameRelayToClientDatagram || gotDgram.RemoteEndpointID != pubA || gotDgram.Datagrams.ECN != 0x02 || string(gotDgram.Datagrams.Contents) != "quic-packet-1" {
		t.Fatalf("B received wrong datagram: %+v err=%v", gotDgram, err)
	}

	batchBytes, err := relay.EncodeClientToRelayMsg(relay.ClientToRelayMsg{
		Type:          relay.FrameClientToRelayDatagramBatch,
		DstEndpointID: pubB,
		Datagrams: relay.Datagrams{
			ECN:         0x03,
			HasBatch:    true,
			SegmentSize: 5,
			Contents:    []byte("helloWORLD"),
		},
	})
	if err != nil {
		t.Fatalf("encode batch: %v", err)
	}
	wsA1.writeBinary(t, batchBytes)

	gotBatchRaw, err := wsB.readBinary(t)
	if err != nil {
		t.Fatalf("B read batch: %v", err)
	}
	gotBatch, err := relay.DecodeRelayToClientMsg(gotBatchRaw, relay.ProtocolV2)
	if err != nil || gotBatch.Type != relay.FrameRelayToClientDatagramBatch || gotBatch.RemoteEndpointID != pubA || gotBatch.Datagrams.SegmentSize != 5 || string(gotBatch.Datagrams.Contents) != "helloWORLD" {
		t.Fatalf("B received wrong batch: %+v err=%v", gotBatch, err)
	}

	// Duplicate EndpointId connection A2 -> A1 receives Status::SameEndpointIdConnected ([0x0d, 0x01])!
	wsA2 := authenticateChallengeWS(t, httpSrv.URL, privA, pubA)
	defer wsA2.close()

	dupStatusRaw, err := wsA1.readBinary(t)
	if err != nil {
		t.Fatalf("A1 read SameEndpointIdConnected status: %v", err)
	}
	if !bytes.Equal(dupStatusRaw, []byte{0x0d, 0x01}) {
		t.Fatalf("expected Status::SameEndpointIdConnected [0d 01], got %x", dupStatusRaw)
	}

	// B sends datagram to A -> delivered to active A2
	bToABytes, _ := relay.EncodeClientToRelayMsg(relay.ClientToRelayMsg{
		Type:          relay.FrameClientToRelayDatagram,
		DstEndpointID: pubA,
		Datagrams:     relay.Datagrams{Contents: []byte("reply-to-active-a2")},
	})
	wsB.writeBinary(t, bToABytes)
	gotAtA2Raw, err := wsA2.readBinary(t)
	if err != nil {
		t.Fatalf("A2 read reply: %v", err)
	}
	gotAtA2, err := relay.DecodeRelayToClientMsg(gotAtA2Raw, relay.ProtocolV2)
	if err != nil || string(gotAtA2.Datagrams.Contents) != "reply-to-active-a2" {
		t.Fatalf("A2 unexpected frame: %+v err=%v", gotAtA2, err)
	}

	// Disconnect both A1 and A2 -> B receives EndpointGone (0x08 || pubA)
	wsA1.close()
	wsA2.close()

	goneRaw, err := wsB.readBinary(t)
	if err != nil {
		t.Fatalf("B read EndpointGone: %v", err)
	}
	goneMsg, err := relay.DecodeRelayToClientMsg(goneRaw, relay.ProtocolV2)
	if err != nil || goneMsg.Type != relay.FrameEndpointGone || goneMsg.GoneEndpointID != pubA {
		t.Fatalf("expected EndpointGone(%x), got %+v err=%v", pubA, goneMsg, err)
	}
}

// --- RFC 9000 / RFC 9001 QUIC v1 Test Client for QAD (/iroh-qad/0) ---

func generateSelfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ecdsa key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}
}

type quicTestKeys struct {
	suite uint16
	aead  cipher.AEAD
	iv    []byte
	hpKey []byte
	aesHP cipher.Block
}

func hkdfExpandLabelSHA256(secret []byte, label string, length int) []byte {
	full := "tls13 " + label
	info := make([]byte, 0, 2+1+len(full)+1)
	info = append(info, byte(length>>8), byte(length), byte(len(full)))
	info = append(info, full...)
	info = append(info, 0)
	out, err := hkdf.Expand(sha256.New, secret, string(info), length)
	if err != nil {
		panic(err)
	}
	return out
}

func newQuicTestKeys(suite uint16, trafficSecret []byte) *quicTestKeys {
	k := &quicTestKeys{suite: suite}
	switch suite {
	case tls.TLS_CHACHA20_POLY1305_SHA256:
		key := hkdfExpandLabelSHA256(trafficSecret, "quic key", 32)
		k.iv = hkdfExpandLabelSHA256(trafficSecret, "quic iv", 12)
		k.hpKey = hkdfExpandLabelSHA256(trafficSecret, "quic hp", 32)
		aead, err := chacha20poly1305.New(key)
		if err != nil {
			panic(err)
		}
		k.aead = aead
	default: // TLS_AES_128_GCM_SHA256
		key := hkdfExpandLabelSHA256(trafficSecret, "quic key", 16)
		k.iv = hkdfExpandLabelSHA256(trafficSecret, "quic iv", 12)
		k.hpKey = hkdfExpandLabelSHA256(trafficSecret, "quic hp", 16)
		blk, err := aes.NewCipher(key)
		if err != nil {
			panic(err)
		}
		aead, err := cipher.NewGCM(blk)
		if err != nil {
			panic(err)
		}
		hpBlk, err := aes.NewCipher(k.hpKey)
		if err != nil {
			panic(err)
		}
		k.aead = aead
		k.aesHP = hpBlk
	}
	return k
}

func (k *quicTestKeys) hpMask(sample []byte) [5]byte {
	var mask [5]byte
	if k.suite == tls.TLS_CHACHA20_POLY1305_SHA256 {
		counter := binary.LittleEndian.Uint32(sample[0:4])
		c, err := chacha20.NewUnauthenticatedCipher(k.hpKey, sample[4:16])
		if err != nil {
			panic(err)
		}
		c.SetCounter(counter)
		c.XORKeyStream(mask[:], mask[:])
		return mask
	}
	var block [16]byte
	k.aesHP.Encrypt(block[:], sample[0:16])
	copy(mask[:], block[:5])
	return mask
}

func (k *quicTestKeys) nonce(pn uint64) []byte {
	n := append([]byte(nil), k.iv...)
	var pnBytes [8]byte
	binary.BigEndian.PutUint64(pnBytes[:], pn)
	for i := 0; i < 8; i++ {
		n[4+i] ^= pnBytes[i]
	}
	return n
}

func appendQuicVarInt(b []byte, v uint64) []byte {
	switch {
	case v <= 63:
		return append(b, byte(v))
	case v <= 16383:
		return append(b, byte(0x40|(v>>8)), byte(v))
	case v <= 1073741823:
		return append(b, byte(0x80|(v>>24)), byte(v>>16), byte(v>>8), byte(v))
	default:
		return append(b,
			byte(0xc0|(v>>56)), byte(v>>48), byte(v>>40), byte(v>>32),
			byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
	}
}

func readQuicVarInt(b []byte) (uint64, int, error) {
	if len(b) == 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	prefix := b[0] >> 6
	length := 1 << prefix
	if len(b) < length {
		return 0, 0, io.ErrUnexpectedEOF
	}
	val := uint64(b[0] & 0x3f)
	for i := 1; i < length; i++ {
		val = (val << 8) | uint64(b[i])
	}
	return val, length, nil
}

func sealQuicLongPacket(pktType uint8, dcid, scid []byte, pn uint64, frames []byte, padTo int, keys *quicTestKeys) []byte {
	var hdr []byte
	hdr = append(hdr, 0xc0|(pktType<<4)|0x03) // Long header, fixed=1, 4-byte PN
	hdr = append(hdr, 0x00, 0x00, 0x00, 0x01) // QUIC v1
	hdr = append(hdr, byte(len(dcid)))
	hdr = append(hdr, dcid...)
	hdr = append(hdr, byte(len(scid)))
	hdr = append(hdr, scid...)
	if pktType == 0 { // Initial token length = 0
		hdr = append(hdr, 0x00)
	}
	plain := append([]byte(nil), frames...)
	if padTo > 0 {
		needed := padTo - (len(hdr) + 2 + 4 + len(plain) + 16)
		if needed > 0 {
			plain = append(plain, make([]byte, needed)...)
		}
	}
	lengthVal := uint64(4 + len(plain) + 16)
	hdr = appendQuicVarInt(hdr, lengthVal)
	pnOffset := len(hdr)
	var pn4 [4]byte
	binary.BigEndian.PutUint32(pn4[:], uint32(pn))
	hdr = append(hdr, pn4[:]...)
	pkt := keys.aead.Seal(hdr, keys.nonce(pn), plain, hdr)
	mask := keys.hpMask(pkt[pnOffset+4 : pnOffset+20])
	pkt[0] ^= mask[0] & 0x0f
	for i := 0; i < 4; i++ {
		pkt[pnOffset+i] ^= mask[1+i]
	}
	return pkt
}

func sealQuicShortPacket(dcid []byte, pn uint64, frames []byte, keys *quicTestKeys) []byte {
	var hdr []byte
	hdr = append(hdr, 0x43) // Short header, fixed=1, 4-byte PN
	hdr = append(hdr, dcid...)
	pnOffset := len(hdr)
	var pn4 [4]byte
	binary.BigEndian.PutUint32(pn4[:], uint32(pn))
	hdr = append(hdr, pn4[:]...)
	pkt := keys.aead.Seal(hdr, keys.nonce(pn), frames, hdr)
	mask := keys.hpMask(pkt[pnOffset+4 : pnOffset+20])
	pkt[0] ^= mask[0] & 0x1f
	for i := 0; i < 4; i++ {
		pkt[pnOffset+i] ^= mask[1+i]
	}
	return pkt
}

func runQADClientProbe(t *testing.T, network string, serverAddr *net.UDPAddr, cipherSuites []uint16) (net.IP, uint16, *net.UDPAddr) {
	t.Helper()
	udpConn, err := net.ListenUDP(network, nil)
	if err != nil {
		t.Fatalf("ListenUDP(%s): %v", network, err)
	}
	defer func() { _ = udpConn.Close() }()
	localAddr := udpConn.LocalAddr().(*net.UDPAddr)

	var clientDCID, clientSCID [8]byte
	_, _ = rand.Read(clientDCID[:])
	_, _ = rand.Read(clientSCID[:])

	initialSalt, _ := hex.DecodeString("38762cf7f55934b34d179ae6a4c80cadccbb7f0a")
	initPRK, _ := hkdf.Extract(sha256.New, clientDCID[:], initialSalt)
	clientInitKeys := newQuicTestKeys(tls.TLS_AES_128_GCM_SHA256, hkdfExpandLabelSHA256(initPRK, "client in", 32))
	serverInitKeys := newQuicTestKeys(tls.TLS_AES_128_GCM_SHA256, hkdfExpandLabelSHA256(initPRK, "server in", 32))

	qclient := tls.QUICClient(&tls.QUICConfig{
		TLSConfig: &tls.Config{
			InsecureSkipVerify: true,
			MinVersion:         tls.VersionTLS13,
			ServerName:         "localhost",
			NextProtos:         []string{relay.ALPNQuicAddrDiscovery},
			CipherSuites:       cipherSuites,
		},
	})
	defer func() { _ = qclient.Close() }()

	// Client transport parameters: initial_source_connection_id (0x0f), max_idle_timeout (0x01 = 30000),
	// max_udp_payload_size (0x03 = 1452), ObservedAddr (0x9f81a176 = 1 receive_only)
	var clientTP []byte
	clientTP = appendQuicVarInt(clientTP, 0x0f)
	clientTP = appendQuicVarInt(clientTP, uint64(len(clientSCID)))
	clientTP = append(clientTP, clientSCID[:]...)
	clientTP = appendQuicVarInt(clientTP, 0x01)
	clientTP = appendQuicVarInt(clientTP, 2)
	clientTP = appendQuicVarInt(clientTP, 15000)
	clientTP = appendQuicVarInt(clientTP, relay.TransportParamObservedAddr)
	clientTP = appendQuicVarInt(clientTP, 1)
	clientTP = appendQuicVarInt(clientTP, 1) // Role::receive_only()
	qclient.SetTransportParameters(clientTP)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := qclient.Start(ctx); err != nil {
		t.Fatalf("qclient.Start: %v", err)
	}

	var hsReadKeys, hsWriteKeys, appReadKeys, appWriteKeys *quicTestKeys
	var serverSCID []byte
	var gotServerObservedTP bool
	var pnInit, pnHS, pnApp uint64

	drainAndSend := func() {
		var initCrypto, hsCrypto []byte
		for {
			ev := qclient.NextEvent()
			if ev.Kind == tls.QUICNoEvent {
				break
			}
			switch ev.Kind {
			case tls.QUICWriteData:
				if ev.Level == tls.QUICEncryptionLevelInitial {
					initCrypto = append(initCrypto, ev.Data...)
				} else if ev.Level == tls.QUICEncryptionLevelHandshake {
					hsCrypto = append(hsCrypto, ev.Data...)
				}
			case tls.QUICSetReadSecret:
				if ev.Level == tls.QUICEncryptionLevelHandshake {
					hsReadKeys = newQuicTestKeys(ev.Suite, ev.Data)
				} else if ev.Level == tls.QUICEncryptionLevelApplication {
					appReadKeys = newQuicTestKeys(ev.Suite, ev.Data)
				}
			case tls.QUICSetWriteSecret:
				if ev.Level == tls.QUICEncryptionLevelHandshake {
					hsWriteKeys = newQuicTestKeys(ev.Suite, ev.Data)
				} else if ev.Level == tls.QUICEncryptionLevelApplication {
					appWriteKeys = newQuicTestKeys(ev.Suite, ev.Data)
				}
			case tls.QUICTransportParameters:
				tp := ev.Data
				for len(tp) > 0 {
					id, n1, err := readQuicVarInt(tp)
					if err != nil {
						t.Fatalf("parse server TP id: %v", err)
					}
					tp = tp[n1:]
					vlen, n2, err := readQuicVarInt(tp)
					if err != nil || uint64(len(tp)-n2) < vlen {
						t.Fatalf("parse server TP len: %v", err)
					}
					val := tp[n2 : n2+int(vlen)]
					tp = tp[n2+int(vlen):]
					if id == relay.TransportParamObservedAddr {
						roleVal, _, err := readQuicVarInt(val)
						if err != nil || roleVal != 0 {
							t.Fatalf("expected server ObservedAddr role=0 (send_only), got %d err=%v", roleVal, err)
						}
						gotServerObservedTP = true
					}
				}
			case tls.QUICErrorEvent:
				t.Fatalf("qclient TLS error: %v", ev.Err)
			}
		}

		// Chunk outgoing Initial CRYPTO frames to <= 1000B per UDP datagram
		for off := 0; off < len(initCrypto); {
			end := min(off+950, len(initCrypto))
			chunk := initCrypto[off:end]
			var fr []byte
			fr = append(fr, 0x06)
			fr = appendQuicVarInt(fr, uint64(off))
			fr = appendQuicVarInt(fr, uint64(len(chunk)))
			fr = append(fr, chunk...)
			dst := clientDCID[:]
			if len(serverSCID) > 0 {
				dst = serverSCID
			}
			pkt := sealQuicLongPacket(0, dst, clientSCID[:], pnInit, fr, 1200, clientInitKeys)
			pnInit++
			if _, err := udpConn.WriteToUDP(pkt, serverAddr); err != nil {
				t.Fatalf("WriteToUDP Initial: %v", err)
			}
			off = end
		}

		if len(hsCrypto) > 0 && hsWriteKeys != nil {
			var fr []byte
			fr = append(fr, 0x06)
			fr = appendQuicVarInt(fr, 0)
			fr = appendQuicVarInt(fr, uint64(len(hsCrypto)))
			fr = append(fr, hsCrypto...)
			pkt := sealQuicLongPacket(2, serverSCID, clientSCID[:], pnHS, fr, 0, hsWriteKeys)
			pnHS++
			if _, err := udpConn.WriteToUDP(pkt, serverAddr); err != nil {
				t.Fatalf("WriteToUDP Handshake: %v", err)
			}
		}
	}

	drainAndSend()

	_ = udpConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 4096)
	var observedIP net.IP
	var observedPort uint16
	var gotHandshakeDoneFrame bool

	initAsm := make(map[uint64][]byte)
	var initNext uint64
	hsAsm := make(map[uint64][]byte)
	var hsNext uint64

	for observedIP == nil {
		n, _, err := udpConn.ReadFromUDP(buf)
		if err != nil {
			t.Fatalf("ReadFromUDP waiting for QAD response: %v", err)
		}
		raw := append([]byte(nil), buf[:n]...)
		for len(raw) > 0 {
			if (raw[0] & 0x80) != 0 {
				// Long Header
				pktType := (raw[0] & 0x30) >> 4
				pos := 5
				dcidLen := int(raw[pos])
				pos += 1 + dcidLen
				scidLen := int(raw[pos])
				scid := append([]byte(nil), raw[pos+1:pos+1+scidLen]...)
				if len(serverSCID) == 0 {
					serverSCID = scid
				}
				pos += 1 + scidLen
				if pktType == 0 {
					tokLen, tn, err := readQuicVarInt(raw[pos:])
					if err != nil {
						t.Fatalf("read token len: %v", err)
					}
					pos += tn + int(tokLen)
				}
				pktLen, ln, err := readQuicVarInt(raw[pos:])
				if err != nil {
					t.Fatalf("read pkt len: %v", err)
				}
				pnOffset := pos + ln
				totalPktLen := pnOffset + int(pktLen)
				thisPkt := raw[:totalPktLen]
				raw = raw[totalPktLen:]

				var rk *quicTestKeys
				var level tls.QUICEncryptionLevel
				if pktType == 0 {
					rk = serverInitKeys
					level = tls.QUICEncryptionLevelInitial
				} else if pktType == 2 {
					rk = hsReadKeys
					level = tls.QUICEncryptionLevelHandshake
				}
				if rk == nil {
					continue
				}
				mask := rk.hpMask(thisPkt[pnOffset+4 : pnOffset+20])
				thisPkt[0] ^= mask[0] & 0x0f
				pnLen := int(thisPkt[0]&0x03) + 1
				var pn uint64
				for i := 0; i < pnLen; i++ {
					thisPkt[pnOffset+i] ^= mask[1+i]
					pn = (pn << 8) | uint64(thisPkt[pnOffset+i])
				}
				plain, err := rk.aead.Open(nil, rk.nonce(pn), thisPkt[pnOffset+pnLen:], thisPkt[:pnOffset+pnLen])
				if err != nil {
					t.Fatalf("decrypt server long packet (type=%d): %v", pktType, err)
				}
				parseQuicFramesForTest(t, plain, func(off uint64, data []byte) {
					if level == tls.QUICEncryptionLevelInitial {
						initAsm[off] = append([]byte(nil), data...)
						for {
							seg, ok := initAsm[initNext]
							if !ok {
								break
							}
							delete(initAsm, initNext)
							initNext += uint64(len(seg))
							if err := qclient.HandleData(level, seg); err != nil {
								t.Fatalf("HandleData Initial: %v", err)
							}
						}
					} else {
						hsAsm[off] = append([]byte(nil), data...)
						for {
							seg, ok := hsAsm[hsNext]
							if !ok {
								break
							}
							delete(hsAsm, hsNext)
							hsNext += uint64(len(seg))
							if err := qclient.HandleData(level, seg); err != nil {
								t.Fatalf("HandleData Handshake: %v", err)
							}
						}
					}
				}, nil, nil)
				drainAndSend()
			} else {
				// 1-RTT Short Header
				if appReadKeys == nil {
					t.Fatalf("received 1-RTT packet before appReadKeys derived")
				}
				pnOffset := 1 + len(clientSCID)
				mask := appReadKeys.hpMask(raw[pnOffset+4 : pnOffset+20])
				raw[0] ^= mask[0] & 0x1f
				pnLen := int(raw[0]&0x03) + 1
				var pn uint64
				for i := 0; i < pnLen; i++ {
					raw[pnOffset+i] ^= mask[1+i]
					pn = (pn << 8) | uint64(raw[pnOffset+i])
				}
				plain, err := appReadKeys.aead.Open(nil, appReadKeys.nonce(pn), raw[pnOffset+pnLen:], raw[:pnOffset+pnLen])
				if err != nil {
					t.Fatalf("decrypt server 1-RTT packet: %v", err)
				}
				raw = nil
				parseQuicFramesForTest(t, plain, func(_ uint64, data []byte) {
					_ = qclient.HandleData(tls.QUICEncryptionLevelApplication, data)
				}, func() {
					gotHandshakeDoneFrame = true
				}, func(ip net.IP, port uint16) {
					observedIP = ip
					observedPort = port
				})
			}
		}
	}

	if !gotServerObservedTP {
		t.Fatalf("server did not advertise ObservedAddr (0x9f81a176 = 0) transport parameter")
	}
	if !gotHandshakeDoneFrame {
		t.Fatalf("server did not send HANDSHAKE_DONE (0x1e) frame")
	}

	// Send graceful APPLICATION_CLOSE (0x1d, error_code=1, reason="finished") just like real iroh!
	if appWriteKeys != nil && len(serverSCID) > 0 {
		var closeFrame []byte
		closeFrame = append(closeFrame, 0x1d) // APPLICATION_CLOSE
		closeFrame = appendQuicVarInt(closeFrame, relay.QADCloseErrorCode)
		closeFrame = appendQuicVarInt(closeFrame, uint64(len(relay.QADCloseReason)))
		closeFrame = append(closeFrame, relay.QADCloseReason...)
		closePkt := sealQuicShortPacket(serverSCID, pnApp, closeFrame, appWriteKeys)
		_, _ = udpConn.WriteToUDP(closePkt, serverAddr)
	}

	return observedIP, observedPort, localAddr
}

func parseQuicFramesForTest(
	t *testing.T,
	plain []byte,
	onCrypto func(offset uint64, data []byte),
	onHandshakeDone func(),
	onObserved func(ip net.IP, port uint16),
) {
	t.Helper()
	for len(plain) > 0 {
		ft, n, err := readQuicVarInt(plain)
		if err != nil {
			t.Fatalf("read frame type: %v", err)
		}
		plain = plain[n:]
		switch ft {
		case 0x00, 0x01: // PADDING, PING
		case 0x02, 0x03: // ACK / ACK_ECN
			_, n1, _ := readQuicVarInt(plain)
			plain = plain[n1:]
			_, n2, _ := readQuicVarInt(plain)
			plain = plain[n2:]
			rc, n3, _ := readQuicVarInt(plain)
			plain = plain[n3:]
			_, n4, _ := readQuicVarInt(plain)
			plain = plain[n4:]
			for i := uint64(0); i < rc; i++ {
				_, ng, _ := readQuicVarInt(plain)
				plain = plain[ng:]
				_, nr, _ := readQuicVarInt(plain)
				plain = plain[nr:]
			}
			if ft == 0x03 {
				for i := 0; i < 3; i++ {
					_, ne, _ := readQuicVarInt(plain)
					plain = plain[ne:]
				}
			}
		case 0x06: // CRYPTO
			off, n1, _ := readQuicVarInt(plain)
			plain = plain[n1:]
			clen, n2, _ := readQuicVarInt(plain)
			plain = plain[n2:]
			data := plain[:clen]
			plain = plain[clen:]
			if onCrypto != nil {
				onCrypto(off, data)
			}
		case 0x1e: // HANDSHAKE_DONE
			if onHandshakeDone != nil {
				onHandshakeDone()
			}
		case relay.FrameObservedIPv4Addr:
			_, ns, _ := readQuicVarInt(plain)
			plain = plain[ns:]
			ip := net.IP(append([]byte(nil), plain[:4]...))
			port := binary.BigEndian.Uint16(plain[4:6])
			plain = plain[6:]
			if onObserved != nil {
				onObserved(ip, port)
			}
		case relay.FrameObservedIPv6Addr:
			_, ns, _ := readQuicVarInt(plain)
			plain = plain[ns:]
			ip := net.IP(append([]byte(nil), plain[:16]...))
			port := binary.BigEndian.Uint16(plain[16:18])
			plain = plain[18:]
			if onObserved != nil {
				onObserved(ip, port)
			}
		default:
			t.Fatalf("unexpected QUIC frame type 0x%x", ft)
		}
	}
}

func TestQADUDPServerIPv4AndIPv6ObservedAddress(t *testing.T) {
	cert := generateSelfSignedCert(t)
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
	}

	// 1. IPv4 QAD with AES-128-GCM & ChaCha20-Poly1305
	qadV4, err := relay.StartQADServer("127.0.0.1:0", tlsCfg)
	if err != nil {
		t.Fatalf("StartQADServer IPv4 failed: %v", err)
	}
	defer func() { _ = qadV4.Close() }()
	srvV4Addr := qadV4.Addr().(*net.UDPAddr)

	for _, suite := range []uint16{tls.TLS_AES_128_GCM_SHA256, tls.TLS_CHACHA20_POLY1305_SHA256} {
		t.Run(fmt.Sprintf("IPv4_suite_0x%x", suite), func(t *testing.T) {
			ip, port, local := runQADClientProbe(t, "udp4", srvV4Addr, []uint16{suite})
			if len(ip) != 4 || !ip.Equal(net.ParseIP("127.0.0.1")) || int(port) != local.Port {
				t.Fatalf("ObservedIpv4Addr mismatch: got %s:%d (len=%d), want 127.0.0.1:%d", ip, port, len(ip), local.Port)
			}
		})
	}

	// 2. Dual-stack UDP listener ([::]:0): IPv4 client MUST receive canonicalized 4B ObservedIpv4Addr (0x9f81a6),
	// and IPv6 client ([::1]) MUST receive 16B ObservedIpv6Addr (0x9f81a7)!
	if qadDual, err := relay.StartQADServer(":0", tlsCfg); err == nil {
		defer func() { _ = qadDual.Close() }()
		dualPort := qadDual.Addr().(*net.UDPAddr).Port

		ip4, port4, local4 := runQADClientProbe(t, "udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: dualPort}, nil)
		if len(ip4) != 4 || !ip4.Equal(net.ParseIP("127.0.0.1")) || int(port4) != local4.Port {
			t.Fatalf("Dual-stack IPv4 canonicalization failed: got %s:%d (len=%d)", ip4, port4, len(ip4))
		}

		if probe6, err := net.ListenUDP("udp6", &net.UDPAddr{IP: net.ParseIP("::1"), Port: 0}); err == nil {
			_ = probe6.Close()
			ip6, port6, local6 := runQADClientProbe(t, "udp6", &net.UDPAddr{IP: net.ParseIP("::1"), Port: dualPort}, nil)
			if len(ip6) != 16 || !ip6.Equal(net.ParseIP("::1")) || int(port6) != local6.Port {
				t.Fatalf("ObservedIpv6Addr mismatch: got %s:%d (len=%d), want [::1]:%d", ip6, port6, len(ip6), local6.Port)
			}
		}
	}
}

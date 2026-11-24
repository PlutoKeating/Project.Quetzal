// SPDX-License-Identifier: AGPL-3.0-only

package relay

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	wsAcceptGUID             = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	defaultEstablishTimeout  = 30 * time.Second
	defaultRelayWriteTimeout = 5 * time.Second
	defaultRelayQueueDepth   = 512
	defaultRelayPingInterval = 15 * time.Second
	noContentChallengeHeader = "X-Iroh-Challenge"
	noContentResponseHeader  = "X-Iroh-Response"
)

type AccessFunc func(endpointID [32]byte, r *http.Request) (allow bool, reason string)

type Config struct {
	WriteTimeout     time.Duration
	EstablishTimeout time.Duration
	PingInterval     time.Duration
	QueueDepth       int
	AccessControl    AccessFunc
}

type clientConn struct {
	id         uint64
	endpointID [32]byte
	version    ProtocolVersion
	ws         *wsStream
	packetCh   chan RelayToClientMsg
	ctrlCh     chan RelayToClientMsg
	done       chan struct{}
	closeOnce  sync.Once
}

func (c *clientConn) stop() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.ws.closeRaw()
	})
}

func (c *clientConn) enqueueStatus(st Status) {
	var msg RelayToClientMsg
	if c.version >= ProtocolV2 {
		msg = RelayToClientMsg{Type: FrameStatus, Status: st}
	} else {
		msg = RelayToClientMsg{Type: FrameHealth, HealthProblem: st.ProblemString()}
	}
	select {
	case c.ctrlCh <- msg:
	case <-c.done:
	default:
	}
}

func (c *clientConn) enqueueEndpointGone(gone [32]byte) {
	msg := RelayToClientMsg{Type: FrameEndpointGone, GoneEndpointID: gone}
	select {
	case c.ctrlCh <- msg:
	case <-c.done:
	default:
	}
}

type endpointState struct {
	active   *clientConn
	inactive []*clientConn
}

type Server struct {
	cfg        Config
	nextConnID atomic.Uint64

	mu      sync.Mutex
	closed  bool
	clients map[[32]byte]*endpointState
	sentTo  map[[32]byte]map[[32]byte]struct{}

	wg sync.WaitGroup
}

func NewServer(cfg Config) *Server {
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = defaultRelayWriteTimeout
	}
	if cfg.EstablishTimeout <= 0 {
		cfg.EstablishTimeout = defaultEstablishTimeout
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = defaultRelayPingInterval
	}
	if cfg.QueueDepth <= 0 {
		cfg.QueueDepth = defaultRelayQueueDepth
	}
	return &Server{
		cfg:     cfg,
		clients: make(map[[32]byte]*endpointState),
		sentTo:  make(map[[32]byte]map[[32]byte]struct{}),
	}
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ping", s.handlePing)
	mux.HandleFunc("GET /generate_204", s.handleGenerate204)
	mux.HandleFunc("GET /relay", s.handleRelayUpgrade)
}

func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.wg.Wait()
		return nil
	}
	s.closed = true
	var toClose []*clientConn
	for _, st := range s.clients {
		if st.active != nil {
			toClose = append(toClose, st.active)
		}
		toClose = append(toClose, st.inactive...)
	}
	s.clients = make(map[[32]byte]*endpointState)
	s.sentTo = make(map[[32]byte]map[[32]byte]struct{})
	s.mu.Unlock()

	for _, c := range toClose {
		c.stop()
	}
	s.wg.Wait()
	return nil
}

func (s *Server) handlePing(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

func isChallengeChar(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '.' || b == '-' || b == '_'
}

func (s *Server) handleGenerate204(w http.ResponseWriter, r *http.Request) {
	ch := r.Header.Get(noContentChallengeHeader)
	if len(ch) > 0 && len(ch) < 64 {
		valid := true
		for i := 0; i < len(ch); i++ {
			if !isChallengeChar(ch[i]) {
				valid = false
				break
			}
		}
		if valid {
			w.Header().Set(noContentResponseHeader, "response "+ch)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func headerContainsTokenCI(h http.Header, key, token string) bool {
	for _, v := range h.Values(key) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func negotiateRelaySubprotocol(h http.Header) (ProtocolVersion, bool) {
	var best ProtocolVersion
	for _, v := range h.Values("Sec-WebSocket-Protocol") {
		for _, part := range strings.Split(v, ",") {
			if ver, ok := ParseProtocolVersion(strings.TrimSpace(part)); ok && ver > best {
				best = ver
			}
		}
	}
	return best, best != 0
}

func computeWSAccept(clientKey string) string {
	sum := sha1.Sum([]byte(clientKey + wsAcceptGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func (s *Server) handleRelayUpgrade(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		http.Error(w, "relay shutting down", http.StatusServiceUnavailable)
		return
	}

	if !headerContainsTokenCI(r.Header, "Upgrade", "websocket") || !headerContainsTokenCI(r.Header, "Connection", "upgrade") {
		http.Error(w, "missing websocket upgrade headers", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(w, "unsupported websocket version", http.StatusBadRequest)
		return
	}
	wsKey := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if wsKey == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return
	}
	protoVer, ok := negotiateRelaySubprotocol(r.Header)
	if !ok {
		http.Error(w, "unsupported Sec-WebSocket-Protocol", http.StatusBadRequest)
		return
	}

	// Capture TLS connection state BEFORE Hijack for RFC 5705 keying material export
	var tlsState *tls.ConnectionState
	if r.TLS != nil {
		stateCopy := *r.TLS
		tlsState = &stateCopy
	}
	authHdr := strings.TrimSpace(r.Header.Get(ClientAuthHeader))

	rc := http.NewResponseController(w)
	netConn, rw, err := rc.Hijack()
	if err != nil {
		http.Error(w, "websocket hijack not supported", http.StatusInternalServerError)
		return
	}
	// Clear any inherited http.Server ReadTimeout/WriteTimeout
	_ = netConn.SetDeadline(time.Time{})

	acceptVal := computeWSAccept(wsKey)
	upgradeResp := fmt.Sprintf(
		"HTTP/1.1 101 Switching Protocols\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: upgrade\r\n"+
			"Sec-WebSocket-Accept: %s\r\n"+
			"Sec-WebSocket-Protocol: %s\r\n\r\n",
		acceptVal, protoVer.String(),
	)
	_ = netConn.SetWriteDeadline(time.Now().Add(s.cfg.WriteTimeout))
	if _, err := rw.WriteString(upgradeResp); err != nil {
		_ = netConn.Close()
		return
	}
	if err := rw.Flush(); err != nil {
		_ = netConn.Close()
		return
	}

	ws := newWSStream(netConn, rw, s.cfg.WriteTimeout)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.serveUpgradedClient(ws, r, tlsState, authHdr, protoVer)
	}()
}

func (s *Server) serveUpgradedClient(
	ws *wsStream,
	r *http.Request,
	tlsState *tls.ConnectionState,
	authHdr string,
	protoVer ProtocolVersion,
) {
	_ = ws.conn.SetReadDeadline(time.Now().Add(s.cfg.EstablishTimeout))

	endpointID, ok := s.performHandshake(ws, tlsState, authHdr)
	if !ok {
		_ = ws.sendClose(1008)
		_ = ws.closeRaw()
		return
	}

	if s.cfg.AccessControl != nil {
		allow, reason := s.cfg.AccessControl(endpointID, r)
		if !allow {
			if reason == "" {
				reason = "not authorized"
			}
			_ = ws.writeBinary(EncodeServerDeniesAuth(reason))
			_ = ws.sendClose(1008)
			_ = ws.closeRaw()
			return
		}
	}

	cc := &clientConn{
		id:         s.nextConnID.Add(1),
		endpointID: endpointID,
		version:    protoVer,
		ws:         ws,
		packetCh:   make(chan RelayToClientMsg, s.cfg.QueueDepth),
		ctrlCh:     make(chan RelayToClientMsg, s.cfg.QueueDepth),
		done:       make(chan struct{}),
	}

	// Register BEFORE sending ServerConfirmsAuth so peer routing is guaranteed active
	// the instant the client observes [0x02], while starting writeLoop AFTER ensures
	// [0x02] is strictly the first frame on the wire.
	if !s.registerClient(cc) {
		cc.stop()
		return
	}
	defer s.unregisterClient(cc)

	if err := ws.writeBinary(EncodeServerConfirmsAuth()); err != nil {
		cc.stop()
		return
	}

	// Clear establishment read deadline; ongoing liveness is maintained via Ping/Pong
	_ = ws.conn.SetReadDeadline(time.Time{})

	var ioWG sync.WaitGroup
	ioWG.Add(1)
	go func() {
		defer ioWG.Done()
		s.writeLoop(cc)
	}()

	s.readLoop(cc)
	cc.stop()
	ioWG.Wait()
}

func (s *Server) performHandshake(ws *wsStream, tlsState *tls.ConnectionState, authHdr string) ([32]byte, bool) {
	var zero [32]byte
	// Fast-path: Concealed-Auth-style TLS 1.3 ExportKeyingMaterial header
	if authHdr != "" {
		km, err := DecodeKeyMaterialClientAuthHeader(authHdr)
		if err != nil {
			// Invalid header formatting -> fall back or reject; upstream iroh-relay only errors on malformed base64/postcard,
			// and falls back on exporter mismatch or missing TLS.
			return zero, false
		}
		if tlsState != nil {
			verErr := VerifyKeyMaterialClientAuth(km, tlsState.ExportKeyingMaterial)
			if verErr == nil {
				return km.PublicKey, true
			}
		}
		// Missing TLS state (behind HTTP reverse proxy) or exporter mismatch -> graceful fallback to ServerChallenge!
	}

	var ch ServerChallenge
	if _, err := rand.Read(ch.Challenge[:]); err != nil {
		return zero, false
	}
	if err := ws.writeBinary(EncodeServerChallenge(ch)); err != nil {
		return zero, false
	}

	clientFrame, err := ws.readBinary()
	if err != nil {
		return zero, false
	}
	ca, err := DecodeClientAuth(clientFrame)
	if err != nil {
		_ = ws.writeBinary(EncodeServerDeniesAuth("invalid client auth frame"))
		return zero, false
	}
	if err := VerifyClientAuth(ca, ch); err != nil {
		_ = ws.writeBinary(EncodeServerDeniesAuth("signature invalid"))
		return zero, false
	}
	return ca.PublicKey, true
}

func (s *Server) registerClient(cc *clientConn) bool {
	var oldActive *clientConn
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return false
	}
	st, exists := s.clients[cc.endpointID]
	if !exists {
		s.clients[cc.endpointID] = &endpointState{active: cc}
	} else {
		oldActive = st.active
		st.active = cc
		if oldActive != nil {
			st.inactive = append(st.inactive, oldActive)
		}
	}
	s.mu.Unlock()

	if oldActive != nil {
		oldActive.enqueueStatus(StatusSameEndpointIDConnected)
	}
	return true
}

func (s *Server) unregisterClient(cc *clientConn) {
	var promoted *clientConn
	var notifyTargets []*clientConn

	s.mu.Lock()
	if st, ok := s.clients[cc.endpointID]; ok {
		if st.active != nil && st.active.id == cc.id {
			if n := len(st.inactive); n > 0 {
				promoted = st.inactive[n-1]
				st.inactive = st.inactive[:n-1]
				st.active = promoted
			} else {
				delete(s.clients, cc.endpointID)
				if peers, hasSent := s.sentTo[cc.endpointID]; hasSent {
					delete(s.sentTo, cc.endpointID)
					for peerID := range peers {
						if peerState, peerOK := s.clients[peerID]; peerOK && peerState.active != nil {
							notifyTargets = append(notifyTargets, peerState.active)
						}
					}
				}
				for _, peerSet := range s.sentTo {
					delete(peerSet, cc.endpointID)
				}
			}
		} else {
			filtered := st.inactive[:0]
			for _, in := range st.inactive {
				if in.id != cc.id {
					filtered = append(filtered, in)
				}
			}
			st.inactive = filtered
		}
	}
	s.mu.Unlock()

	if promoted != nil {
		promoted.enqueueStatus(StatusHealthy)
	}
	for _, target := range notifyTargets {
		target.enqueueEndpointGone(cc.endpointID)
	}
}

func (s *Server) forwardDatagram(src [32]byte, dst [32]byte, dg Datagrams, isBatch bool) {
	var dstConn *clientConn
	s.mu.Lock()
	if st, ok := s.clients[dst]; ok && st.active != nil {
		dstConn = st.active
		peers := s.sentTo[src]
		if peers == nil {
			peers = make(map[[32]byte]struct{})
			s.sentTo[src] = peers
		}
		peers[dst] = struct{}{}
	}
	s.mu.Unlock()

	if dstConn == nil {
		return
	}
	ft := FrameRelayToClientDatagram
	if isBatch {
		ft = FrameRelayToClientDatagramBatch
	}
	msg := RelayToClientMsg{
		Type:             ft,
		RemoteEndpointID: src,
		Datagrams:        dg,
	}
	select {
	case dstConn.packetCh <- msg:
	case <-dstConn.done:
	default:
		// Per-client queue full: drop packet to avoid head-of-line blocking sender
	}
}

func (s *Server) readLoop(cc *clientConn) {
	for {
		select {
		case <-cc.done:
			return
		default:
		}
		raw, err := cc.ws.readBinary()
		if err != nil {
			return
		}
		msg, err := DecodeClientToRelayMsg(raw)
		if err != nil {
			return
		}
		switch msg.Type {
		case FrameClientToRelayDatagram:
			s.forwardDatagram(cc.endpointID, msg.DstEndpointID, msg.Datagrams, false)
		case FrameClientToRelayDatagramBatch:
			s.forwardDatagram(cc.endpointID, msg.DstEndpointID, msg.Datagrams, true)
		case FramePing:
			pong := RelayToClientMsg{Type: FramePong, PingPong: msg.PingPong}
			select {
			case cc.ctrlCh <- pong:
			case <-cc.done:
				return
			}
		case FramePong:
			// Client echoed server keepalive ping
		}
	}
}

func (s *Server) writeLoop(cc *clientConn) {
	ticker := time.NewTicker(s.cfg.PingInterval)
	defer ticker.Stop()

	sendMsg := func(msg RelayToClientMsg) bool {
		encoded, err := EncodeRelayToClientMsg(msg, cc.version)
		if err != nil {
			return true
		}
		if err := cc.ws.writeBinary(encoded); err != nil {
			cc.stop()
			return false
		}
		return true
	}

	for {
		// Prioritize control frames (Status, Pong, EndpointGone) before bulk datagrams
		select {
		case <-cc.done:
			return
		case ctrl := <-cc.ctrlCh:
			if !sendMsg(ctrl) {
				return
			}
			continue
		default:
		}

		select {
		case <-cc.done:
			return
		case ctrl := <-cc.ctrlCh:
			if !sendMsg(ctrl) {
				return
			}
		case pkt := <-cc.packetCh:
			if !sendMsg(pkt) {
				return
			}
		case <-ticker.C:
			var data [8]byte
			_, _ = rand.Read(data[:])
			if !sendMsg(RelayToClientMsg{Type: FramePing, PingPong: data}) {
				return
			}
		}
	}
}

// --- RFC 6455 Binary WebSocket Framing ---

type wsStream struct {
	conn         net.Conn
	r            *bufio.Reader
	w            *bufio.Writer
	writeMu      sync.Mutex
	writeTimeout time.Duration
}

func newWSStream(conn net.Conn, rw *bufio.ReadWriter, writeTimeout time.Duration) *wsStream {
	return &wsStream{
		conn:         conn,
		r:            rw.Reader,
		w:            rw.Writer,
		writeTimeout: writeTimeout,
	}
}

func (ws *wsStream) closeRaw() error {
	return ws.conn.Close()
}

func (ws *wsStream) writeFrame(opcode byte, payload []byte) error {
	ws.writeMu.Lock()
	defer ws.writeMu.Unlock()

	if err := ws.conn.SetWriteDeadline(time.Now().Add(ws.writeTimeout)); err != nil {
		return err
	}
	var hdr [10]byte
	hdr[0] = 0x80 | (opcode & 0x0f) // FIN=1, server-to-client unmasked
	hdrLen := 2
	n := len(payload)
	switch {
	case n < 126:
		hdr[1] = byte(n)
	case n <= 65535:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
		hdrLen = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
		hdrLen = 10
	}
	if _, err := ws.w.Write(hdr[:hdrLen]); err != nil {
		return err
	}
	if n > 0 {
		if _, err := ws.w.Write(payload); err != nil {
			return err
		}
	}
	return ws.w.Flush()
}

func (ws *wsStream) writeBinary(payload []byte) error {
	return ws.writeFrame(0x2, payload)
}

func (ws *wsStream) sendClose(code uint16) error {
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], code)
	return ws.writeFrame(0x8, p[:])
}

func (ws *wsStream) readBinary() ([]byte, error) {
	var msgBuf []byte
	inFragment := false
	fragmentIsBinary := false

	for {
		var hdr2 [2]byte
		if _, err := io.ReadFull(ws.r, hdr2[:]); err != nil {
			return nil, err
		}
		fin := (hdr2[0] & 0x80) != 0
		rsv := hdr2[0] & 0x70
		if rsv != 0 {
			return nil, errors.New("ws: nonzero rsv bits")
		}
		opcode := hdr2[0] & 0x0f
		masked := (hdr2[1] & 0x80) != 0
		if !masked {
			// RFC 6455 §5.1: client-to-server frames MUST be masked
			return nil, errors.New("ws: unmasked client frame")
		}

		payloadLen := uint64(hdr2[1] & 0x7f)
		switch payloadLen {
		case 126:
			var ext2 [2]byte
			if _, err := io.ReadFull(ws.r, ext2[:]); err != nil {
				return nil, err
			}
			payloadLen = uint64(binary.BigEndian.Uint16(ext2[:]))
		case 127:
			var ext8 [8]byte
			if _, err := io.ReadFull(ws.r, ext8[:]); err != nil {
				return nil, err
			}
			payloadLen = binary.BigEndian.Uint64(ext8[:])
		}

		if payloadLen > MaxWSFrameSize || uint64(len(msgBuf))+payloadLen > MaxWSFrameSize {
			return nil, ErrFrameTooLarge
		}

		var maskKey [4]byte
		if _, err := io.ReadFull(ws.r, maskKey[:]); err != nil {
			return nil, err
		}

		// Control frames (0x8..0xf) MUST NOT be fragmented and MUST be <= 125 bytes
		if opcode >= 0x8 {
			if !fin || payloadLen > 125 {
				return nil, errors.New("ws: invalid control frame")
			}
			ctrl := make([]byte, int(payloadLen))
			if _, err := io.ReadFull(ws.r, ctrl); err != nil {
				return nil, err
			}
			for i := range ctrl {
				ctrl[i] ^= maskKey[i&3]
			}
			switch opcode {
			case 0x8: // Close
				_ = ws.writeFrame(0x8, ctrl)
				return nil, io.EOF
			case 0x9: // Ping
				if err := ws.writeFrame(0xA, ctrl); err != nil {
					return nil, err
				}
			case 0xA: // Pong
			default:
				return nil, errors.New("ws: unsupported control opcode")
			}
			continue
		}

		chunk := make([]byte, int(payloadLen))
		if _, err := io.ReadFull(ws.r, chunk); err != nil {
			return nil, err
		}
		for i := range chunk {
			chunk[i] ^= maskKey[i&3]
		}

		switch opcode {
		case 0x0: // Continuation
			if !inFragment {
				return nil, errors.New("ws: unexpected continuation frame")
			}
			msgBuf = append(msgBuf, chunk...)
			if fin {
				inFragment = false
				if fragmentIsBinary {
					out := msgBuf
					msgBuf = nil
					return out, nil
				}
				msgBuf = nil
			}
		case 0x1, 0x2: // Text (ignored per WsBytesFramed) or Binary
			if inFragment {
				return nil, errors.New("ws: new data frame during fragmentation")
			}
			isBin := opcode == 0x2
			if fin {
				if isBin {
					return chunk, nil
				}
				continue
			}
			inFragment = true
			fragmentIsBinary = isBin
			msgBuf = append(msgBuf[:0], chunk...)
		default:
			return nil, errors.New("ws: unsupported data opcode")
		}
	}
}

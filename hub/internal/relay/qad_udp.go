// SPDX-License-Identifier: AGPL-3.0-only

package relay

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"hash"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/chacha20poly1305"
)

const (
	ALPNQuicAddrDiscovery      = "/iroh-qad/0"
	TransportParamObservedAddr = 0x9f81a176
	FrameObservedIPv4Addr      = 0x9f81a6
	FrameObservedIPv6Addr      = 0x9f81a7
	QADCloseErrorCode          = 1
	QADCloseReason             = "finished"

	quicVersion1    uint32 = 0x00000001
	qadServerCIDLen        = 8
	qadIdleTimeout         = 15 * time.Second
	qadMaxSessions         = 4096
	qadCryptoChunk         = 950
)

var quicV1InitialSalt = []byte{
	0x38, 0x76, 0x2c, 0xf7, 0xf5, 0x59, 0x34, 0xb3, 0x4d, 0x17,
	0x9a, 0xe6, 0xa4, 0xc8, 0x0c, 0xad, 0xcc, 0xbb, 0x7f, 0x0a,
}

type quicPacketKeys struct {
	suite uint16
	aead  cipher.AEAD
	iv    []byte
	hpKey []byte
	aesHP cipher.Block
}

func hkdfExpandTLS13Label(h func() hash.Hash, secret []byte, label string, length int) ([]byte, error) {
	fullLabel := "tls13 " + label
	info := make([]byte, 0, 2+1+len(fullLabel)+1)
	info = append(info, byte(length>>8), byte(length), byte(len(fullLabel)))
	info = append(info, fullLabel...)
	info = append(info, 0)
	return hkdf.Expand(h, secret, string(info), length)
}

func deriveQuicKeys(suite uint16, secret []byte) (*quicPacketKeys, error) {
	var hashFn func() hash.Hash
	var keyLen, hpLen int
	switch suite {
	case tls.TLS_AES_128_GCM_SHA256:
		hashFn = sha256.New
		keyLen, hpLen = 16, 16
	case tls.TLS_AES_256_GCM_SHA384:
		hashFn = sha512.New384
		keyLen, hpLen = 32, 32
	case tls.TLS_CHACHA20_POLY1305_SHA256:
		hashFn = sha256.New
		keyLen, hpLen = 32, 32
	default:
		return nil, errors.New("unsupported quic tls cipher suite")
	}

	key, err := hkdfExpandTLS13Label(hashFn, secret, "quic key", keyLen)
	if err != nil {
		return nil, err
	}
	iv, err := hkdfExpandTLS13Label(hashFn, secret, "quic iv", 12)
	if err != nil {
		return nil, err
	}
	hpKey, err := hkdfExpandTLS13Label(hashFn, secret, "quic hp", hpLen)
	if err != nil {
		return nil, err
	}

	pk := &quicPacketKeys{
		suite: suite,
		iv:    iv,
		hpKey: hpKey,
	}
	if suite == tls.TLS_CHACHA20_POLY1305_SHA256 {
		aead, err := chacha20poly1305.New(key)
		if err != nil {
			return nil, err
		}
		pk.aead = aead
		return pk, nil
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	hpBlk, err := aes.NewCipher(hpKey)
	if err != nil {
		return nil, err
	}
	pk.aead = aead
	pk.aesHP = hpBlk
	return pk, nil
}

func deriveInitialKeys(clientInitialDCID []byte) (readKeys, writeKeys *quicPacketKeys, err error) {
	initSecret, err := hkdf.Extract(sha256.New, clientInitialDCID, quicV1InitialSalt)
	if err != nil {
		return nil, nil, err
	}
	clientIn, err := hkdfExpandTLS13Label(sha256.New, initSecret, "client in", 32)
	if err != nil {
		return nil, nil, err
	}
	serverIn, err := hkdfExpandTLS13Label(sha256.New, initSecret, "server in", 32)
	if err != nil {
		return nil, nil, err
	}
	rk, err := deriveQuicKeys(tls.TLS_AES_128_GCM_SHA256, clientIn)
	if err != nil {
		return nil, nil, err
	}
	wk, err := deriveQuicKeys(tls.TLS_AES_128_GCM_SHA256, serverIn)
	if err != nil {
		return nil, nil, err
	}
	return rk, wk, nil
}

func (k *quicPacketKeys) headerMask(sample []byte) ([5]byte, error) {
	var mask [5]byte
	if len(sample) < 16 {
		return mask, io.ErrUnexpectedEOF
	}
	if k.suite == tls.TLS_CHACHA20_POLY1305_SHA256 {
		counter := binary.LittleEndian.Uint32(sample[0:4])
		c, err := chacha20.NewUnauthenticatedCipher(k.hpKey, sample[4:16])
		if err != nil {
			return mask, err
		}
		c.SetCounter(counter)
		c.XORKeyStream(mask[:], mask[:])
		return mask, nil
	}
	var out [16]byte
	k.aesHP.Encrypt(out[:], sample[0:16])
	copy(mask[:], out[:5])
	return mask, nil
}

func (k *quicPacketKeys) packetNonce(pn uint64) []byte {
	nonce := make([]byte, 12)
	copy(nonce, k.iv)
	var pn8 [8]byte
	binary.BigEndian.PutUint64(pn8[:], pn)
	for i := 0; i < 8; i++ {
		nonce[4+i] ^= pn8[i]
	}
	return nonce
}

// decodePacketNumber reconstructs a full 62-bit QUIC packet number per RFC 9000 Appendix A.3.
func decodePacketNumber(largestPN int64, truncatedPN uint64, pnNBits uint) uint64 {
	expectedPN := uint64(largestPN + 1)
	pnWin := uint64(1) << pnNBits
	pnHWin := pnWin / 2
	pnMask := pnWin - 1

	candidatePN := (expectedPN & ^pnMask) | truncatedPN
	if candidatePN+pnHWin <= expectedPN && candidatePN < (1<<62)-pnWin {
		return candidatePN + pnWin
	}
	if candidatePN > expectedPN+pnHWin && candidatePN >= pnWin {
		return candidatePN - pnWin
	}
	return candidatePN
}

type cryptoAssembler struct {
	nextOffset uint64
	segments   map[uint64][]byte
	buffered   int
}

func newCryptoAssembler() *cryptoAssembler {
	return &cryptoAssembler{segments: make(map[uint64][]byte)}
}

func (a *cryptoAssembler) push(offset uint64, data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, nil
	}
	end := offset + uint64(len(data))
	if end <= a.nextOffset {
		return nil, nil
	}
	if offset < a.nextOffset {
		trim := a.nextOffset - offset
		data = data[trim:]
		offset = a.nextOffset
	}
	if a.buffered+len(data) > 64*1024 {
		return nil, errors.New("quic crypto buffer exceeded")
	}
	if existing, ok := a.segments[offset]; !ok || len(data) > len(existing) {
		a.segments[offset] = append([]byte(nil), data...)
		a.buffered += len(data)
	}
	var out []byte
	for {
		var best []byte
		for segOff, seg := range a.segments {
			if segOff <= a.nextOffset && segOff+uint64(len(seg)) > a.nextOffset {
				trim := a.nextOffset - segOff
				cand := seg[trim:]
				if len(cand) > len(best) {
					best = cand
				}
				delete(a.segments, segOff)
			} else if segOff+uint64(len(seg)) <= a.nextOffset {
				delete(a.segments, segOff)
			}
		}
		if len(best) == 0 {
			break
		}
		out = append(out, best...)
		a.nextOffset += uint64(len(best))
	}
	return out, nil
}

type pnSpaceState struct {
	readKeys      *quicPacketKeys
	writeKeys     *quicPacketKeys
	largestRecvPN int64
	minContigPN   int64
	needAck       bool
	nextSendPN    uint64
	writeOffset   uint64
	cryptoIn      *cryptoAssembler
}

func newPNSpace() *pnSpaceState {
	return &pnSpaceState{
		largestRecvPN: -1,
		minContigPN:   -1,
		cryptoIn:      newCryptoAssembler(),
	}
}

func (s *pnSpaceState) recordReceived(pn uint64, ackEliciting bool) {
	ipn := int64(pn)
	if s.largestRecvPN < 0 {
		s.largestRecvPN = ipn
		s.minContigPN = ipn
	} else {
		if ipn == s.largestRecvPN+1 {
			s.largestRecvPN = ipn
		} else if ipn > s.largestRecvPN+1 {
			s.largestRecvPN = ipn
			s.minContigPN = ipn
		}
	}
	if ackEliciting {
		s.needAck = true
	}
}

func (s *pnSpaceState) appendAckFrame(dst []byte) []byte {
	if !s.needAck || s.largestRecvPN < 0 {
		return dst
	}
	s.needAck = false
	firstRange := uint64(s.largestRecvPN - s.minContigPN)
	dst = append(dst, 0x02) // ACK frame
	dst = AppendQuicVarInt(dst, uint64(s.largestRecvPN))
	dst = AppendQuicVarInt(dst, 0) // ACK Delay = 0
	dst = AppendQuicVarInt(dst, 0) // ACK Range Count = 0
	dst = AppendQuicVarInt(dst, firstRange)
	return dst
}

type qadSession struct {
	serverSCID        [qadServerCIDLen]byte
	clientInitialDCID []byte
	clientSCID        []byte
	remoteAddr        *net.UDPAddr

	qconn     *tls.QUICConn
	cancelCtx context.CancelFunc

	spaces [3]*pnSpaceState // 0=Initial, 1=Handshake, 2=Application

	addressValidated        bool
	bytesRecv               int
	bytesSent               int
	clientWantsObservedAddr bool
	handshakeDone           bool
	reportSent              bool
	reportRetransmits       int
	lastReportSentAt        time.Time
	lastActive              time.Time
	closed                  bool
}

type QADServer struct {
	udpConn   *net.UDPConn
	tlsConfig *tls.Config

	mu          sync.Mutex
	closed      bool
	byServerCID map[[qadServerCIDLen]byte]*qadSession
	byInitDCID  map[string]*qadSession

	requests atomic.Uint64
	reports  atomic.Uint64

	stopCh chan struct{}
	wg     sync.WaitGroup
}

// QADStats 是地址发现的运行计数快照：只有总量，不含任何对端地址。
type QADStats struct {
	// Requests 是累计受理的地址发现请求数（每个新建的 QUIC 会话计一次）。
	Requests uint64
	// Reports 是累计完成握手并回报了对端公网地址的会话数（重传不重复计）。
	Reports uint64
}

func (q *QADServer) Stats() QADStats {
	return QADStats{Requests: q.requests.Load(), Reports: q.reports.Load()}
}

func StartQADServer(bindAddr string, baseTLS *tls.Config) (*QADServer, error) {
	if baseTLS == nil || (len(baseTLS.Certificates) == 0 && baseTLS.GetCertificate == nil) {
		return nil, errors.New("qad server requires a TLS 1.3 certificate")
	}
	udpAddr, err := net.ResolveUDPAddr("udp", bindAddr)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, err
	}

	tlsCfg := baseTLS.Clone()
	tlsCfg.MinVersion = tls.VersionTLS13
	tlsCfg.NextProtos = []string{ALPNQuicAddrDiscovery}

	srv := &QADServer{
		udpConn:     conn,
		tlsConfig:   tlsCfg,
		byServerCID: make(map[[qadServerCIDLen]byte]*qadSession),
		byInitDCID:  make(map[string]*qadSession),
		stopCh:      make(chan struct{}),
	}

	srv.wg.Add(1)
	go func() {
		defer srv.wg.Done()
		srv.serveLoop()
	}()
	return srv, nil
}

func (q *QADServer) Addr() net.Addr {
	return q.udpConn.LocalAddr()
}

func (q *QADServer) Close() error {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		q.wg.Wait()
		return nil
	}
	q.closed = true
	close(q.stopCh)
	_ = q.udpConn.Close()
	for _, sess := range q.byServerCID {
		sess.cleanup()
	}
	q.byServerCID = make(map[[qadServerCIDLen]byte]*qadSession)
	q.byInitDCID = make(map[string]*qadSession)
	q.mu.Unlock()

	q.wg.Wait()
	return nil
}

func (s *qadSession) cleanup() {
	if s.closed {
		return
	}
	s.closed = true
	if s.cancelCtx != nil {
		s.cancelCtx()
	}
	if s.qconn != nil {
		_ = s.qconn.Close()
	}
}

func (q *QADServer) serveLoop() {
	buf := make([]byte, 65535)
	nextSweep := time.Now().Add(150 * time.Millisecond)

	for {
		_ = q.udpConn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
		n, remoteAddr, err := q.udpConn.ReadFromUDP(buf)
		now := time.Now()
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				q.maintenanceTick(now)
				continue
			}
			select {
			case <-q.stopCh:
				return
			default:
				return
			}
		}

		if n > 0 && remoteAddr != nil {
			pktCopy := make([]byte, n)
			copy(pktCopy, buf[:n])
			q.mu.Lock()
			if !q.closed {
				q.handleDatagramLocked(pktCopy, remoteAddr, now)
			}
			q.mu.Unlock()
		}

		if now.After(nextSweep) {
			q.maintenanceTick(now)
			nextSweep = now.Add(150 * time.Millisecond)
		}
	}
}

func (q *QADServer) maintenanceTick(now time.Time) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	for cid, sess := range q.byServerCID {
		if sess.closed || now.Sub(sess.lastActive) > qadIdleTimeout {
			sess.cleanup()
			delete(q.byServerCID, cid)
			delete(q.byInitDCID, string(sess.clientInitialDCID))
			continue
		}
		if sess.handshakeDone && sess.reportSent && sess.reportRetransmits < 2 && now.Sub(sess.lastReportSentAt) >= 150*time.Millisecond {
			sess.reportRetransmits++
			q.sendHandshakeDoneAndObservedLocked(sess, now)
		}
	}
}

func buildServerTransportParams(origDCID []byte, serverSCID [qadServerCIDLen]byte) []byte {
	var tp []byte
	// original_destination_connection_id (0x00)
	tp = AppendQuicVarInt(tp, 0x00)
	tp = AppendQuicVarInt(tp, uint64(len(origDCID)))
	tp = append(tp, origDCID...)

	// max_idle_timeout (0x01) = 30000 ms
	var idleVar []byte
	idleVar = AppendQuicVarInt(idleVar, 30_000)
	tp = AppendQuicVarInt(tp, 0x01)
	tp = AppendQuicVarInt(tp, uint64(len(idleVar)))
	tp = append(tp, idleVar...)

	// stateless_reset_token (0x02) = 16 random bytes
	var resetTok [16]byte
	_, _ = rand.Read(resetTok[:])
	tp = AppendQuicVarInt(tp, 0x02)
	tp = AppendQuicVarInt(tp, 16)
	tp = append(tp, resetTok[:]...)

	// max_udp_payload_size (0x03) = 1452
	var mtuVar []byte
	mtuVar = AppendQuicVarInt(mtuVar, 1452)
	tp = AppendQuicVarInt(tp, 0x03)
	tp = AppendQuicVarInt(tp, uint64(len(mtuVar)))
	tp = append(tp, mtuVar...)

	// active_connection_id_limit (0x0e) = 2
	tp = AppendQuicVarInt(tp, 0x0e)
	tp = AppendQuicVarInt(tp, 1)
	tp = AppendQuicVarInt(tp, 2)

	// initial_source_connection_id (0x0f)
	tp = AppendQuicVarInt(tp, 0x0f)
	tp = AppendQuicVarInt(tp, qadServerCIDLen)
	tp = append(tp, serverSCID[:]...)

	// ObservedAddr (0x9f81a176 -> 8-byte QUIC varint c0 00 00 00 9f 81 a1 76), len=1, value=0 (Role::send_only())
	tp = AppendQuicVarInt(tp, TransportParamObservedAddr)
	tp = AppendQuicVarInt(tp, 1)
	tp = AppendQuicVarInt(tp, 0)

	return tp
}

func encodeObservedAddrFrame(dst []byte, remote *net.UDPAddr, seqNo uint64) []byte {
	if remote == nil || len(remote.IP) == 0 {
		return dst
	}
	if ip4 := remote.IP.To4(); ip4 != nil {
		dst = AppendQuicVarInt(dst, FrameObservedIPv4Addr)
		dst = AppendQuicVarInt(dst, seqNo)
		dst = append(dst, ip4[:4]...)
	} else if ip16 := remote.IP.To16(); ip16 != nil {
		dst = AppendQuicVarInt(dst, FrameObservedIPv6Addr)
		dst = AppendQuicVarInt(dst, seqNo)
		dst = append(dst, ip16[:16]...)
	} else {
		return dst
	}
	var portBE [2]byte
	binary.BigEndian.PutUint16(portBE[:], uint16(remote.Port))
	dst = append(dst, portBE[:]...)
	return dst
}

func (q *QADServer) createSessionLocked(origDCID, clientSCID []byte, remote *net.UDPAddr, now time.Time) (*qadSession, error) {
	if len(q.byServerCID) >= qadMaxSessions {
		for cid, old := range q.byServerCID {
			if !old.addressValidated {
				old.cleanup()
				delete(q.byServerCID, cid)
				delete(q.byInitDCID, string(old.clientInitialDCID))
				break
			}
		}
		if len(q.byServerCID) >= qadMaxSessions {
			return nil, errors.New("qad max sessions reached")
		}
	}
	rk, wk, err := deriveInitialKeys(origDCID)
	if err != nil {
		return nil, err
	}

	var scid [qadServerCIDLen]byte
	for {
		if _, err := rand.Read(scid[:]); err != nil {
			return nil, err
		}
		if _, exists := q.byServerCID[scid]; !exists {
			break
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	qconn := tls.QUICServer(&tls.QUICConfig{TLSConfig: q.tlsConfig})
	qconn.SetTransportParameters(buildServerTransportParams(origDCID, scid))
	if err := qconn.Start(ctx); err != nil {
		cancel()
		_ = qconn.Close()
		return nil, err
	}

	initSpace := newPNSpace()
	initSpace.readKeys = rk
	initSpace.writeKeys = wk

	sess := &qadSession{
		serverSCID:        scid,
		clientInitialDCID: append([]byte(nil), origDCID...),
		clientSCID:        append([]byte(nil), clientSCID...),
		remoteAddr:        remote,
		qconn:             qconn,
		cancelCtx:         cancel,
		spaces: [3]*pnSpaceState{
			initSpace,
			newPNSpace(),
			newPNSpace(),
		},
		lastActive: now,
	}
	q.byServerCID[scid] = sess
	q.byInitDCID[string(origDCID)] = sess
	q.requests.Add(1)
	return sess, nil
}

func sendVersionNegotiation(conn *net.UDPConn, remote *net.UDPAddr, clientDCID, clientSCID []byte) {
	var pkt []byte
	var rnd [1]byte
	_, _ = rand.Read(rnd[:])
	pkt = append(pkt, 0x80|(rnd[0]&0x7f))
	pkt = append(pkt, 0, 0, 0, 0) // Version 0
	pkt = append(pkt, byte(len(clientSCID)))
	pkt = append(pkt, clientSCID...)
	pkt = append(pkt, byte(len(clientDCID)))
	pkt = append(pkt, clientDCID...)
	pkt = append(pkt, 0x00, 0x00, 0x00, 0x01) // Supported: QUIC v1
	_, _ = conn.WriteToUDP(pkt, remote)
}

func (q *QADServer) handleDatagramLocked(datagram []byte, remote *net.UDPAddr, now time.Time) {
	totalDatagramLen := len(datagram)
	raw := datagram

	var activeSess *qadSession
	for len(raw) > 0 {
		first := raw[0]
		if (first & 0x80) != 0 {
			// Long Header packet
			if len(raw) < 7 {
				return
			}
			version := binary.BigEndian.Uint32(raw[1:5])
			pos := 5
			dcidLen := int(raw[pos])
			pos++
			if dcidLen > 20 || len(raw) < pos+dcidLen+1 {
				return
			}
			dcid := raw[pos : pos+dcidLen]
			pos += dcidLen

			scidLen := int(raw[pos])
			pos++
			if scidLen > 20 || len(raw) < pos+scidLen {
				return
			}
			scid := raw[pos : pos+scidLen]
			pos += scidLen

			if version == 0 {
				return
			}
			if version != quicVersion1 {
				if totalDatagramLen >= 1200 {
					sendVersionNegotiation(q.udpConn, remote, dcid, scid)
				}
				return
			}

			pktType := (first & 0x30) >> 4
			if pktType == 0 { // Initial: Token Length + Token
				tokLen, tn, err := ReadQuicVarInt(raw[pos:])
				if err != nil || uint64(len(raw)-pos-tn) < tokLen {
					return
				}
				pos += tn + int(tokLen)
			} else if pktType != 2 {
				// Ignore 0-RTT (1) or Retry (3); skip packet via Length field
				pktLen, ln, err := ReadQuicVarInt(raw[pos:])
				if err != nil || uint64(len(raw)-pos-ln) < pktLen {
					return
				}
				raw = raw[pos+ln+int(pktLen):]
				continue
			}

			pktLen, ln, err := ReadQuicVarInt(raw[pos:])
			if err != nil {
				return
			}
			pnOffset := pos + ln
			if uint64(len(raw)-pnOffset) < pktLen || pktLen < 20 {
				return
			}
			totalPktLen := pnOffset + int(pktLen)
			thisPkt := raw[:totalPktLen]
			raw = raw[totalPktLen:]

			sess := activeSess
			if sess == nil {
				if len(dcid) == qadServerCIDLen {
					var cidKey [qadServerCIDLen]byte
					copy(cidKey[:], dcid)
					sess = q.byServerCID[cidKey]
				}
				if sess == nil && pktType == 0 {
					sess = q.byInitDCID[string(dcid)]
				}
				if sess == nil && pktType == 0 && totalDatagramLen >= 1200 && len(dcid) >= 8 {
					created, err := q.createSessionLocked(dcid, scid, remote, now)
					if err != nil {
						return
					}
					sess = created
				}
			}
			if sess == nil || sess.closed {
				return
			}
			activeSess = sess
			sess.remoteAddr = remote
			sess.lastActive = now

			spaceIdx := 0
			level := tls.QUICEncryptionLevelInitial
			if pktType == 2 {
				spaceIdx = 1
				level = tls.QUICEncryptionLevelHandshake
			}
			space := sess.spaces[spaceIdx]
			if space.readKeys == nil || pnOffset+20 > len(thisPkt) {
				continue
			}

			mask, err := space.readKeys.headerMask(thisPkt[pnOffset+4 : pnOffset+20])
			if err != nil {
				continue
			}
			unmaskedPkt := append([]byte(nil), thisPkt...)
			unmaskedPkt[0] ^= mask[0] & 0x0f
			pnLen := int(unmaskedPkt[0]&0x03) + 1
			if pnOffset+pnLen+16 > len(unmaskedPkt) {
				continue
			}
			var truncPN uint64
			for i := 0; i < pnLen; i++ {
				unmaskedPkt[pnOffset+i] ^= mask[1+i]
				truncPN = (truncPN << 8) | uint64(unmaskedPkt[pnOffset+i])
			}
			fullPN := decodePacketNumber(space.largestRecvPN, truncPN, uint(pnLen*8))
			plain, err := space.readKeys.aead.Open(
				nil,
				space.readKeys.packetNonce(fullPN),
				unmaskedPkt[pnOffset+pnLen:],
				unmaskedPkt[:pnOffset+pnLen],
			)
			if err != nil {
				continue
			}
			if pktType == 2 {
				sess.addressValidated = true
				delete(q.byInitDCID, string(sess.clientInitialDCID))
			}
			q.processDecryptedPayloadLocked(sess, spaceIdx, level, fullPN, plain, now)
		} else {
			// 1-RTT Short Header packet (consumes rest of UDP datagram)
			if len(raw) < 1+qadServerCIDLen+20 {
				return
			}
			sess := activeSess
			if sess == nil {
				var cidKey [qadServerCIDLen]byte
				copy(cidKey[:], raw[1:1+qadServerCIDLen])
				sess = q.byServerCID[cidKey]
			}
			if sess == nil || sess.closed {
				return
			}
			activeSess = sess
			sess.remoteAddr = remote
			sess.lastActive = now

			space := sess.spaces[2]
			pnOffset := 1 + qadServerCIDLen
			if space.readKeys == nil {
				return
			}
			mask, err := space.readKeys.headerMask(raw[pnOffset+4 : pnOffset+20])
			if err != nil {
				return
			}
			unmaskedPkt := append([]byte(nil), raw...)
			unmaskedPkt[0] ^= mask[0] & 0x1f
			pnLen := int(unmaskedPkt[0]&0x03) + 1
			if pnOffset+pnLen+16 > len(unmaskedPkt) {
				return
			}
			var truncPN uint64
			for i := 0; i < pnLen; i++ {
				unmaskedPkt[pnOffset+i] ^= mask[1+i]
				truncPN = (truncPN << 8) | uint64(unmaskedPkt[pnOffset+i])
			}
			fullPN := decodePacketNumber(space.largestRecvPN, truncPN, uint(pnLen*8))
			plain, err := space.readKeys.aead.Open(
				nil,
				space.readKeys.packetNonce(fullPN),
				unmaskedPkt[pnOffset+pnLen:],
				unmaskedPkt[:pnOffset+pnLen],
			)
			if err != nil {
				return
			}
			sess.addressValidated = true
			raw = nil
			q.processDecryptedPayloadLocked(sess, 2, tls.QUICEncryptionLevelApplication, fullPN, plain, now)
		}
	}

	if activeSess != nil {
		activeSess.bytesRecv += totalDatagramLen
		q.flushPendingLocked(activeSess, now)
	}
}

func (q *QADServer) processDecryptedPayloadLocked(
	sess *qadSession,
	spaceIdx int,
	level tls.QUICEncryptionLevel,
	pn uint64,
	plain []byte,
	now time.Time,
) {
	space := sess.spaces[spaceIdx]
	ackEliciting := false
	var pathChallenges [][8]byte

	cur := plain
	for len(cur) > 0 {
		ft, n, err := ReadQuicVarInt(cur)
		if err != nil {
			return
		}
		cur = cur[n:]
		switch ft {
		case 0x00: // PADDING
		case 0x01, 0x1f: // PING, IMMEDIATE_ACK
			ackEliciting = true
		case 0x02, 0x03: // ACK / ACK_ECN
			largestAcked, n1, err := ReadQuicVarInt(cur)
			if err != nil {
				return
			}
			cur = cur[n1:]
			_, n2, err := ReadQuicVarInt(cur)
			if err != nil {
				return
			}
			cur = cur[n2:]
			rangeCount, n3, err := ReadQuicVarInt(cur)
			if err != nil {
				return
			}
			cur = cur[n3:]
			_, n4, err := ReadQuicVarInt(cur)
			if err != nil {
				return
			}
			cur = cur[n4:]
			for i := uint64(0); i < rangeCount; i++ {
				_, ng, err := ReadQuicVarInt(cur)
				if err != nil {
					return
				}
				cur = cur[ng:]
				_, nr, err := ReadQuicVarInt(cur)
				if err != nil {
					return
				}
				cur = cur[nr:]
			}
			if ft == 0x03 {
				for i := 0; i < 3; i++ {
					_, ne, err := ReadQuicVarInt(cur)
					if err != nil {
						return
					}
					cur = cur[ne:]
				}
			}
			if spaceIdx == 2 && sess.reportSent && largestAcked >= 0 {
				// Client acknowledged our 1-RTT HANDSHAKE_DONE + OBSERVED_ADDRESS packet!
				sess.reportRetransmits = 99
			}
		case 0x06: // CRYPTO
			ackEliciting = true
			off, n1, err := ReadQuicVarInt(cur)
			if err != nil {
				return
			}
			cur = cur[n1:]
			clen, n2, err := ReadQuicVarInt(cur)
			if err != nil || uint64(len(cur)-n2) < clen {
				return
			}
			cur = cur[n2:]
			data := cur[:int(clen)]
			cur = cur[int(clen):]

			contig, err := space.cryptoIn.push(off, data)
			if err != nil {
				sess.cleanup()
				return
			}
			if len(contig) > 0 {
				if err := sess.qconn.HandleData(level, contig); err != nil {
					sess.cleanup()
					return
				}
			}
		case 0x18: // NEW_CONNECTION_ID
			ackEliciting = true
			_, n1, err := ReadQuicVarInt(cur) // seq
			if err != nil {
				return
			}
			cur = cur[n1:]
			_, n2, err := ReadQuicVarInt(cur) // retire_prior_to
			if err != nil {
				return
			}
			cur = cur[n2:]
			if len(cur) < 1 {
				return
			}
			cidL := int(cur[0])
			cur = cur[1:]
			if cidL < 1 || cidL > 20 || len(cur) < cidL+16 {
				return
			}
			cur = cur[cidL+16:]
		case 0x19: // RETIRE_CONNECTION_ID
			ackEliciting = true
			_, n1, err := ReadQuicVarInt(cur)
			if err != nil {
				return
			}
			cur = cur[n1:]
		case 0x1a: // PATH_CHALLENGE
			ackEliciting = true
			if len(cur) < 8 {
				return
			}
			var ch8 [8]byte
			copy(ch8[:], cur[:8])
			cur = cur[8:]
			pathChallenges = append(pathChallenges, ch8)
		case 0x1b: // PATH_RESPONSE
			ackEliciting = true
			if len(cur) < 8 {
				return
			}
			cur = cur[8:]
		case 0x1c, 0x1d: // CONNECTION_CLOSE, APPLICATION_CLOSE
			// Client gracefully finished QAD probe (e.g. error_code=1, "finished")
			sess.cleanup()
			delete(q.byServerCID, sess.serverSCID)
			delete(q.byInitDCID, string(sess.clientInitialDCID))
			return
		default:
			// Unknown frame inside 1-RTT/Handshake: stop parsing remaining frames safely
			cur = nil
		}
	}

	space.recordReceived(pn, ackEliciting)

	if spaceIdx == 2 && len(pathChallenges) > 0 && sess.spaces[2].writeKeys != nil {
		var frames []byte
		frames = space.appendAckFrame(frames)
		for _, pc := range pathChallenges {
			frames = append(frames, 0x1b) // PATH_RESPONSE
			frames = append(frames, pc[:]...)
		}
		q.sendShortPacketLocked(sess, frames, now)
	}
}

func (q *QADServer) parseClientTransportParams(sess *qadSession, tp []byte) {
	for len(tp) > 0 {
		id, n1, err := ReadQuicVarInt(tp)
		if err != nil {
			return
		}
		tp = tp[n1:]
		vlen, n2, err := ReadQuicVarInt(tp)
		if err != nil || uint64(len(tp)-n2) < vlen {
			return
		}
		val := tp[n2 : n2+int(vlen)]
		tp = tp[n2+int(vlen):]

		switch id {
		case 0x0f: // initial_source_connection_id
			sess.clientSCID = append([]byte(nil), val...)
		case TransportParamObservedAddr:
			role, _, err := ReadQuicVarInt(val)
			if err == nil && (role == 1 || role == 2) {
				sess.clientWantsObservedAddr = true
			}
		}
	}
}

func (q *QADServer) flushPendingLocked(sess *qadSession, now time.Time) {
	if sess.closed {
		return
	}
	var cryptoOut [3][]byte
	justCompleted := false

	for {
		ev := sess.qconn.NextEvent()
		if ev.Kind == tls.QUICNoEvent {
			break
		}
		switch ev.Kind {
		case tls.QUICSetReadSecret:
			idx := levelIndex(ev.Level)
			if idx >= 0 {
				keys, err := deriveQuicKeys(ev.Suite, ev.Data)
				if err != nil {
					sess.cleanup()
					return
				}
				sess.spaces[idx].readKeys = keys
			}
		case tls.QUICSetWriteSecret:
			idx := levelIndex(ev.Level)
			if idx >= 0 {
				keys, err := deriveQuicKeys(ev.Suite, ev.Data)
				if err != nil {
					sess.cleanup()
					return
				}
				sess.spaces[idx].writeKeys = keys
			}
		case tls.QUICWriteData:
			idx := levelIndex(ev.Level)
			if idx >= 0 {
				cryptoOut[idx] = append(cryptoOut[idx], ev.Data...)
			}
		case tls.QUICTransportParameters:
			q.parseClientTransportParams(sess, ev.Data)
		case tls.QUICHandshakeDone:
			if sess.qconn.ConnectionState().NegotiatedProtocol != ALPNQuicAddrDiscovery {
				sess.cleanup()
				return
			}
			sess.handshakeDone = true
			sess.addressValidated = true
			justCompleted = true
		case tls.QUICErrorEvent:
			sess.cleanup()
			return
		}
	}

	// 1. Send Initial space ACK + CRYPTO chunks
	initSp := sess.spaces[0]
	if initSp.writeKeys != nil && (initSp.needAck || len(cryptoOut[0]) > 0) {
		if len(cryptoOut[0]) == 0 {
			var frames []byte
			frames = initSp.appendAckFrame(frames)
			if len(frames) > 0 {
				q.sendLongPacketLocked(sess, 0, frames, now)
			}
		} else {
			for off := 0; off < len(cryptoOut[0]); {
				end := min(off+qadCryptoChunk, len(cryptoOut[0]))
				chunk := cryptoOut[0][off:end]
				var frames []byte
				frames = initSp.appendAckFrame(frames)
				frames = append(frames, 0x06)
				frames = AppendQuicVarInt(frames, initSp.writeOffset)
				frames = AppendQuicVarInt(frames, uint64(len(chunk)))
				frames = append(frames, chunk...)
				initSp.writeOffset += uint64(len(chunk))
				q.sendLongPacketLocked(sess, 0, frames, now)
				off = end
			}
		}
	}

	// 2. Send Handshake space ACK + CRYPTO chunks
	hsSp := sess.spaces[1]
	if hsSp.writeKeys != nil && (hsSp.needAck || len(cryptoOut[1]) > 0) {
		if len(cryptoOut[1]) == 0 {
			var frames []byte
			frames = hsSp.appendAckFrame(frames)
			if len(frames) > 0 {
				q.sendLongPacketLocked(sess, 2, frames, now)
			}
		} else {
			for off := 0; off < len(cryptoOut[1]); {
				end := min(off+qadCryptoChunk, len(cryptoOut[1]))
				chunk := cryptoOut[1][off:end]
				var frames []byte
				frames = hsSp.appendAckFrame(frames)
				frames = append(frames, 0x06)
				frames = AppendQuicVarInt(frames, hsSp.writeOffset)
				frames = AppendQuicVarInt(frames, uint64(len(chunk)))
				frames = append(frames, chunk...)
				hsSp.writeOffset += uint64(len(chunk))
				q.sendLongPacketLocked(sess, 2, frames, now)
				off = end
			}
		}
	}

	// 3. Send 1-RTT HANDSHAKE_DONE + OBSERVED_ADDRESS (+ any NewSessionTicket CRYPTO / ACK)
	appSp := sess.spaces[2]
	if appSp.writeKeys != nil && (justCompleted || appSp.needAck || len(cryptoOut[2]) > 0) {
		if justCompleted {
			q.sendHandshakeDoneAndObservedLocked(sess, now)
		} else if appSp.needAck {
			var frames []byte
			frames = appSp.appendAckFrame(frames)
			if len(frames) > 0 {
				q.sendShortPacketLocked(sess, frames, now)
			}
		}
	}
}

func (q *QADServer) sendHandshakeDoneAndObservedLocked(sess *qadSession, now time.Time) {
	appSp := sess.spaces[2]
	if appSp.writeKeys == nil {
		return
	}
	var frames []byte
	frames = appSp.appendAckFrame(frames)
	frames = append(frames, 0x1e) // HANDSHAKE_DONE
	if sess.clientWantsObservedAddr && sess.remoteAddr != nil {
		frames = encodeObservedAddrFrame(frames, sess.remoteAddr, 0)
		if !sess.reportSent {
			q.reports.Add(1)
		}
	}
	sess.reportSent = true
	sess.lastReportSentAt = now
	q.sendShortPacketLocked(sess, frames, now)
}

func (q *QADServer) sendLongPacketLocked(sess *qadSession, pktType uint8, frames []byte, _ time.Time) {
	spaceIdx := 0
	if pktType == 2 {
		spaceIdx = 1
	}
	sp := sess.spaces[spaceIdx]
	if sp.writeKeys == nil || len(frames) == 0 {
		return
	}

	var hdr []byte
	hdr = append(hdr, 0xc0|(pktType<<4)|0x03) // Long header, Fixed=1, 4-byte PN
	hdr = append(hdr, 0x00, 0x00, 0x00, 0x01) // QUIC v1
	hdr = append(hdr, byte(len(sess.clientSCID)))
	hdr = append(hdr, sess.clientSCID...)
	hdr = append(hdr, qadServerCIDLen)
	hdr = append(hdr, sess.serverSCID[:]...)
	if pktType == 0 {
		hdr = append(hdr, 0x00) // Token length = 0
	}

	lengthVal := uint64(4 + len(frames) + 16)
	hdr = AppendQuicVarInt(hdr, lengthVal)
	pnOffset := len(hdr)

	pn := sp.nextSendPN
	sp.nextSendPN++
	var pn4 [4]byte
	binary.BigEndian.PutUint32(pn4[:], uint32(pn))
	hdr = append(hdr, pn4[:]...)

	pkt := sp.writeKeys.aead.Seal(hdr, sp.writeKeys.packetNonce(pn), frames, hdr)
	mask, err := sp.writeKeys.headerMask(pkt[pnOffset+4 : pnOffset+20])
	if err != nil {
		return
	}
	pkt[0] ^= mask[0] & 0x0f
	for i := 0; i < 4; i++ {
		pkt[pnOffset+i] ^= mask[1+i]
	}

	// RFC 9000 §8.1 3x anti-amplification guard prior to address validation
	if !sess.addressValidated && sess.bytesSent+len(pkt) > 3*sess.bytesRecv {
		return
	}
	sess.bytesSent += len(pkt)
	_, _ = q.udpConn.WriteToUDP(pkt, sess.remoteAddr)
}

func (q *QADServer) sendShortPacketLocked(sess *qadSession, frames []byte, _ time.Time) {
	sp := sess.spaces[2]
	if sp.writeKeys == nil || len(frames) == 0 {
		return
	}

	var hdr []byte
	hdr = append(hdr, 0x43) // Short header, Fixed=1, 4-byte PN
	hdr = append(hdr, sess.clientSCID...)
	pnOffset := len(hdr)

	pn := sp.nextSendPN
	sp.nextSendPN++
	var pn4 [4]byte
	binary.BigEndian.PutUint32(pn4[:], uint32(pn))
	hdr = append(hdr, pn4[:]...)

	pkt := sp.writeKeys.aead.Seal(hdr, sp.writeKeys.packetNonce(pn), frames, hdr)
	mask, err := sp.writeKeys.headerMask(pkt[pnOffset+4 : pnOffset+20])
	if err != nil {
		return
	}
	pkt[0] ^= mask[0] & 0x1f
	for i := 0; i < 4; i++ {
		pkt[pnOffset+i] ^= mask[1+i]
	}

	sess.bytesSent += len(pkt)
	_, _ = q.udpConn.WriteToUDP(pkt, sess.remoteAddr)
}

func levelIndex(level tls.QUICEncryptionLevel) int {
	switch level {
	case tls.QUICEncryptionLevelInitial:
		return 0
	case tls.QUICEncryptionLevelHandshake:
		return 1
	case tls.QUICEncryptionLevelApplication:
		return 2
	default:
		return -1
	}
}

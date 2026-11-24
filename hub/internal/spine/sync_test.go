// SPDX-License-Identifier: AGPL-3.0-only

package spine_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"lukechampine.com/blake3"
	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/lease"
	"quetzalcoatl-hub/internal/spine"
	"quetzalcoatl-hub/internal/store"
)

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "spec", "vectors", "spine_pack_aad.json")); err == nil {
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
		t.Fatalf("hex decode: %v", err)
	}
	return b
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

type spinePackVectorFile struct {
	Identity struct {
		AgentID   string `json:"agent_id"`
		DeviceID  string `json:"device_id"`
		PubkeyHex string `json:"device_ed25519_pubkey_hex"`
	} `json:"identity"`
	Events []struct {
		HLCU128Hex string `json:"hlc_u128_hex"`
	} `json:"events"`
	NegativeCases []struct {
		ID                 string `json:"id"`
		ExpectedErrorCode  string `json:"expected_error_code"`
		TamperedAADUTF8    string `json:"tampered_aad_utf8"`
		LocalTrustedWallMs uint64 `json:"local_trusted_wall_ms"`
		RemoteHLCU128Hex   string `json:"remote_hlc_u128_hex"`
	} `json:"negative_cases"`
	Packfile struct {
		CanonicalAADUTF8      string `json:"canonical_aad_utf8"`
		CiphertextHex         string `json:"ciphertext_hex"`
		Compartment           string `json:"compartment"`
		DEKWrapNonceHex       string `json:"dek_wrap_nonce_hex"`
		Epoch                 uint64 `json:"epoch"`
		PackIDBlake3Hex       string `json:"pack_id_blake3_hex"`
		PackNonceHex          string `json:"pack_nonce_hex"`
		PaddedBucketLen       int    `json:"padded_bucket_len"`
		UncompressedBlake3Hex string `json:"uncompressed_blake3_hex"`
		UncompressedJSONLUTF8 string `json:"uncompressed_jsonl_utf8"`
		WrappedDEKHex         string `json:"wrapped_dek_hex"`
	} `json:"packfile"`
}

func doJSON(t *testing.T, client *http.Client, method, url, bearer string, reqBody any) (*http.Response, []byte) {
	t.Helper()
	var rdr io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("new req: %v", err)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("do req: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, raw
}

func registerPasskeyAgent(t *testing.T, client *http.Client, baseURL, agentID, deviceID string) (string, [32]byte) {
	t.Helper()
	var rootSeed [32]byte
	_, _ = rand.Read(rootSeed[:])
	rootPriv := ed25519.NewKeyFromSeed(rootSeed[:])
	rootPub := rootPriv.Public().(ed25519.PublicKey)

	devPub, _, _ := ed25519.GenerateKey(rand.Reader)
	xw, err := auth.GenerateXWingKeyPair()
	if err != nil {
		t.Fatalf("GenerateXWingKeyPair: %v", err)
	}
	xwPK := xw.PublicKeyBytes()

	resp, raw := doJSON(t, client, http.MethodPost, baseURL+"/v1/auth/passkey/register/begin", "", map[string]any{
		"agent_id":                  agentID,
		"device_id":                 deviceID,
		"root_verifying_key_hex":    hex.EncodeToString(rootPub),
		"device_ed25519_pubkey_hex": hex.EncodeToString(devPub),
		"device_xwing_pubkey_hex":   hex.EncodeToString(xwPK[:]),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register/begin status=%d body=%s", resp.StatusCode, raw)
	}
	var beg struct {
		ChallengeID  string `json:"challenge_id"`
		ChallengeB64 string `json:"challenge_b64"`
		RPID         string `json:"rp_id"`
	}
	_ = json.Unmarshal(raw, &beg)

	pkPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pkPubBytes := elliptic.Marshal(elliptic.P256(), pkPriv.PublicKey.X, pkPriv.PublicKey.Y)
	clientData := fmt.Sprintf(`{"type":"webauthn.create","challenge":%q,"origin":"https://hub.quetzalcoatl.example"}`, beg.ChallengeB64)
	cdHash := sha256.Sum256([]byte(clientData))
	rpHash := sha256.Sum256([]byte(beg.RPID))
	authData := make([]byte, 37)
	copy(authData[0:32], rpHash[:])
	authData[32] = 0x05
	binary.BigEndian.PutUint32(authData[33:37], 1)
	digest := sha256.Sum256(append(append([]byte(nil), authData...), cdHash[:]...))
	sigASN1, _ := ecdsa.SignASN1(rand.Reader, pkPriv, digest[:])

	var prf [32]byte
	_, _ = rand.Read(prf[:])
	slot1, err := auth.WrapWithPasskeyPRF(agentID, rootSeed, prf)
	if err != nil {
		t.Fatalf("WrapWithPasskeyPRF: %v", err)
	}
	resp, raw = doJSON(t, client, http.MethodPost, baseURL+"/v1/auth/passkey/register/finish", "", map[string]any{
		"challenge_id":           beg.ChallengeID,
		"credential_id":          "cred-" + agentID + "-" + deviceID,
		"alg":                    -7,
		"public_key_hex":         hex.EncodeToString(pkPubBytes),
		"client_data_json_b64":   base64.RawURLEncoding.EncodeToString([]byte(clientData)),
		"authenticator_data_b64": base64.RawURLEncoding.EncodeToString(authData),
		"signature_b64":          base64.RawURLEncoding.EncodeToString(sigASN1),
		"slot1_envelope":         slot1,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register/finish status=%d body=%s", resp.StatusCode, raw)
	}
	var fin struct {
		SessionToken string `json:"session_token"`
	}
	_ = json.Unmarshal(raw, &fin)
	return fin.SessionToken, rootSeed
}

func TestSigV4PresignedPutSignerAndVerifier(t *testing.T) {
	cfg := store.SigV4Config{
		Endpoint:        "https://s3.us-east-1.amazonaws.com",
		Region:          "auto",
		Bucket:          "quetzalcoatl-packs",
		AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
		SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		UsePathStyle:    true,
	}
	payload := []byte("encrypted-pack-payload-bytes")
	sum := sha256.Sum256(payload)
	shaHex := hex.EncodeToString(sum[:])
	now := time.Unix(1_795_400_000, 0).UTC()

	putURL, headers, err := store.PresignSigV4Put(cfg, "agents/a1/pack1.bin", int64(len(payload)), shaHex, 15*time.Minute, now)
	if err != nil {
		t.Fatalf("PresignSigV4Put: %v", err)
	}
	if strings.Contains(strings.ToLower(putURL), "policy") {
		t.Fatalf("MUST use Presigned PUT, NEVER PresignedPostPolicy: %s", putURL)
	}
	if !strings.Contains(putURL, "X-Amz-Algorithm=AWS4-HMAC-SHA256") || !strings.Contains(putURL, "x-amz-content-sha256") {
		t.Fatalf("SigV4 PUT URL missing required signed headers: %s", putURL)
	}

	req, err := http.NewRequest(http.MethodPut, putURL, bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("new PUT req: %v", err)
	}
	req.ContentLength = int64(len(payload))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	objKey, gotLen, gotSHA, err := store.VerifySigV4PresignedPut(req, cfg, now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("VerifySigV4PresignedPut valid: %v", err)
	}
	if objKey != "agents/a1/pack1.bin" || gotLen != int64(len(payload)) || gotSHA != shaHex {
		t.Fatalf("verified metadata mismatch: key=%s len=%d sha=%s", objKey, gotLen, gotSHA)
	}

	// Tampered Content-Length MUST fail verification!
	reqBadLen, _ := http.NewRequest(http.MethodPut, putURL, bytes.NewReader(append(payload, 0x00)))
	reqBadLen.ContentLength = int64(len(payload) + 1)
	for k, v := range headers {
		reqBadLen.Header.Set(k, v)
	}
	if _, _, _, err := store.VerifySigV4PresignedPut(reqBadLen, cfg, now.Add(2*time.Minute)); err == nil {
		t.Fatalf("expected SigV4 verification to fail on Content-Length mismatch")
	}

	// Expired URL MUST fail verification!
	if _, _, _, err := store.VerifySigV4PresignedPut(req, cfg, now.Add(20*time.Minute)); err == nil {
		t.Fatalf("expected SigV4 verification to fail after expiry")
	}
}

func setupTestHub(t *testing.T, defaultQuotaBytes int64) (*httptest.Server, *store.SQLiteStore, *fakeClock, string, string) {
	t.Helper()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "hub.sqlite")
	blobDir := filepath.Join(tmpDir, "blobs")

	st, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteStore: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	clk := &fakeClock{now: time.UnixMilli(1_795_400_000_000)}
	var secret [32]byte
	copy(secret[:], bytes.Repeat([]byte{0x42}, 32))
	var oprfSeed [32]byte
	copy(oprfSeed[:], bytes.Repeat([]byte{0x11}, 32))
	var opaquePriv [32]byte
	opaquePrivBytes, _ := hex.DecodeString("acd7483bdc0eb4286b40586867aed6f0140159fd00ee3383abc86636300bb80c")
	copy(opaquePriv[:], opaquePrivBytes)

	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	blobs, err := store.NewLocalBlobStore(blobDir, srv.URL, secret, st, clk.Now)
	if err != nil {
		t.Fatalf("NewLocalBlobStore: %v", err)
	}
	blobs.RegisterRoutes(mux)

	authSvc, err := auth.NewService(st, blobs, auth.Config{
		RPID:                      "hub.quetzalcoatl.example",
		AllowedOrigins:            []string{"https://hub.quetzalcoatl.example"},
		ServerIdentity:            "server:quetzalcoatl-hub:v2",
		OPRFMasterSeed:            oprfSeed,
		ServerOpaquePrivateScalar: opaquePriv,
		PairingHMACSecret:         secret,
		DefaultAgentQuotaBytes:    defaultQuotaBytes,
	}, clk.Now)
	if err != nil {
		t.Fatalf("auth.NewService: %v", err)
	}
	authSvc.RegisterRoutes(mux)

	spineSvc, err := spine.NewService(st, blobs, authSvc, spine.DefaultMaxPackBytes, clk.Now)
	if err != nil {
		t.Fatalf("spine.NewService: %v", err)
	}
	spineSvc.RegisterRoutes(mux)

	leaseSvc, err := lease.NewService(st, authSvc, 30_000, 120_000, clk.Now)
	if err != nil {
		t.Fatalf("lease.NewService: %v", err)
	}
	leaseSvc.RegisterRoutes(mux)

	return srv, st, clk, dbPath, blobDir
}

func TestSpinePackPresignedPutSyncQuotaHLCDriftAndIDOR(t *testing.T) {
	rawVec, err := os.ReadFile(filepath.Join(findRepoRoot(t), "spec", "vectors", "spine_pack_aad.json"))
	if err != nil {
		t.Fatalf("read spine_pack_aad.json: %v", err)
	}
	var vec spinePackVectorFile
	if err := json.Unmarshal(rawVec, &vec); err != nil {
		t.Fatalf("unmarshal spine_pack_aad.json: %v", err)
	}

	// Quota = 2500 bytes: allows 2 x 1040B packs (2080B), rejects 3rd 1040B pack (3120B > 2500B)!
	srv, _, _, dbPath, blobDir := setupTestHub(t, 2500)
	client := srv.Client()

	agentA := vec.Identity.AgentID
	devA := vec.Identity.DeviceID
	tokenA, _ := registerPasskeyAgent(t, client, srv.URL, agentA, devA)

	const agentB = "888f4a90-7c20-4d31-8b12-9a0b1c2d3e88"
	const devB = "88020304-0506-8708-890a-0b0c0d0e0f88"
	tokenB, _ := registerPasskeyAgent(t, client, srv.URL, agentB, devB)

	ciphertext := mustHex(t, vec.Packfile.CiphertextHex)
	ctSHA := sha256.Sum256(ciphertext)
	ctSHAHex := hex.EncodeToString(ctSHA[:])

	var aad store.PackAad
	if err := json.Unmarshal([]byte(vec.Packfile.CanonicalAADUTF8), &aad); err != nil {
		t.Fatalf("parse canonical AAD: %v", err)
	}
	if aad.CanonicalJSON() != vec.Packfile.CanonicalAADUTF8 {
		t.Fatalf("PackAad.CanonicalJSON mismatch:\n got: %s\nwant: %s", aad.CanonicalJSON(), vec.Packfile.CanonicalAADUTF8)
	}

	// 1. Presign PUT for Pack 1 (vector pack)
	resp, raw := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/presign", tokenA, map[string]any{
		"pack_id":        vec.Packfile.PackIDBlake3Hex,
		"content_length": len(ciphertext),
		"sha256_hex":     ctSHAHex,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("presign status=%d body=%s", resp.StatusCode, raw)
	}
	var presignResp struct {
		UploadID        string            `json:"upload_id"`
		PutURL          string            `json:"put_url"`
		RequiredHeaders map[string]string `json:"required_headers"`
	}
	_ = json.Unmarshal(raw, &presignResp)

	// 2. Negative: Presigned PUT with wrong byte length MUST fail!
	badLenReq, _ := http.NewRequest(http.MethodPut, presignResp.PutURL, bytes.NewReader(ciphertext[:len(ciphertext)-5]))
	badLenReq.ContentLength = int64(len(ciphertext) - 5)
	for k, v := range presignResp.RequiredHeaders {
		badLenReq.Header.Set(k, v)
	}
	badLenResp, err := client.Do(badLenReq)
	if err != nil {
		t.Fatalf("do badLen PUT: %v", err)
	}
	_ = badLenResp.Body.Close()
	if badLenResp.StatusCode == http.StatusOK || badLenResp.StatusCode == http.StatusCreated {
		t.Fatalf("expected Presigned PUT with wrong length to be rejected, got %d", badLenResp.StatusCode)
	}

	// 3. Negative: Presigned PUT with corrupted byte (SHA-256 mismatch) MUST fail!
	corrupted := append([]byte(nil), ciphertext...)
	corrupted[len(corrupted)-1] ^= 0xff
	badSHAReq, _ := http.NewRequest(http.MethodPut, presignResp.PutURL, bytes.NewReader(corrupted))
	badSHAReq.ContentLength = int64(len(corrupted))
	for k, v := range presignResp.RequiredHeaders {
		badSHAReq.Header.Set(k, v)
	}
	badSHAResp, err := client.Do(badSHAReq)
	if err != nil {
		t.Fatalf("do badSHA PUT: %v", err)
	}
	_ = badSHAResp.Body.Close()
	if badSHAResp.StatusCode == http.StatusOK || badSHAResp.StatusCode == http.StatusCreated {
		t.Fatalf("expected Presigned PUT with SHA-256 mismatch to be rejected, got %d", badSHAResp.StatusCode)
	}

	// 4. Commit before valid upload MUST fail!
	preCommitResp, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/commit", tokenA, map[string]any{
		"upload_id":          presignResp.UploadID,
		"pack_id":            vec.Packfile.PackIDBlake3Hex,
		"aad":                aad,
		"aad_utf8":           vec.Packfile.CanonicalAADUTF8,
		"dek_wrap_nonce_hex": vec.Packfile.DEKWrapNonceHex,
		"wrapped_dek_hex":    vec.Packfile.WrappedDEKHex,
		"pack_nonce_hex":     vec.Packfile.PackNonceHex,
		"content_length":     len(ciphertext),
		"sha256_hex":         ctSHAHex,
	})
	if preCommitResp.StatusCode == http.StatusOK {
		t.Fatalf("expected commit before successful upload to fail")
	}

	// 5. Valid Presigned PUT upload
	putReq, _ := http.NewRequest(http.MethodPut, presignResp.PutURL, bytes.NewReader(ciphertext))
	putReq.ContentLength = int64(len(ciphertext))
	for k, v := range presignResp.RequiredHeaders {
		putReq.Header.Set(k, v)
	}
	putResp, err := client.Do(putReq)
	if err != nil {
		t.Fatalf("do valid PUT: %v", err)
	}
	putBody, _ := io.ReadAll(putResp.Body)
	_ = putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK && putResp.StatusCode != http.StatusCreated {
		t.Fatalf("valid PUT failed status=%d body=%s", putResp.StatusCode, putBody)
	}

	// 6. Negative: +10m Future HLC Clock Drift Poisoning MUST be rejected with CLOCK_DRIFT_EXCEEDED!
	poisonedAAD := aad
	poisonedAAD.MaxHLC = vec.NegativeCases[2].RemoteHLCU128Hex
	driftResp, driftRaw := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/commit", tokenA, map[string]any{
		"upload_id":          presignResp.UploadID,
		"pack_id":            vec.Packfile.PackIDBlake3Hex,
		"aad":                poisonedAAD,
		"aad_utf8":           poisonedAAD.CanonicalJSON(),
		"dek_wrap_nonce_hex": vec.Packfile.DEKWrapNonceHex,
		"wrapped_dek_hex":    vec.Packfile.WrappedDEKHex,
		"pack_nonce_hex":     vec.Packfile.PackNonceHex,
		"content_length":     len(ciphertext),
		"sha256_hex":         ctSHAHex,
	})
	if driftResp.StatusCode == http.StatusOK || !bytes.Contains(driftRaw, []byte("CLOCK_DRIFT_EXCEEDED")) {
		t.Fatalf("expected +10m HLC poisoning to fail with CLOCK_DRIFT_EXCEEDED, got status=%d body=%s", driftResp.StatusCode, driftRaw)
	}

	// 7. Negative: Non-power-of-two padded_len MUST be rejected!
	badBucketAAD := aad
	badBucketAAD.PaddedLen = 300
	bucketResp, _ := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/commit", tokenA, map[string]any{
		"upload_id":          presignResp.UploadID,
		"pack_id":            vec.Packfile.PackIDBlake3Hex,
		"aad":                badBucketAAD,
		"aad_utf8":           badBucketAAD.CanonicalJSON(),
		"dek_wrap_nonce_hex": vec.Packfile.DEKWrapNonceHex,
		"wrapped_dek_hex":    vec.Packfile.WrappedDEKHex,
		"pack_nonce_hex":     vec.Packfile.PackNonceHex,
		"content_length":     len(ciphertext),
		"sha256_hex":         ctSHAHex,
	})
	if bucketResp.StatusCode == http.StatusOK {
		t.Fatalf("expected non-power-of-two padded_len=300 to be rejected")
	}

	// 8. Valid Commit -> server_seq = 1, and idempotent re-commit returns server_seq = 1!
	commitPayload := map[string]any{
		"upload_id":          presignResp.UploadID,
		"pack_id":            vec.Packfile.PackIDBlake3Hex,
		"aad":                aad,
		"aad_utf8":           vec.Packfile.CanonicalAADUTF8,
		"dek_wrap_nonce_hex": vec.Packfile.DEKWrapNonceHex,
		"wrapped_dek_hex":    vec.Packfile.WrappedDEKHex,
		"pack_nonce_hex":     vec.Packfile.PackNonceHex,
		"content_length":     len(ciphertext),
		"sha256_hex":         ctSHAHex,
	}
	cResp1, cRaw1 := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/commit", tokenA, commitPayload)
	if cResp1.StatusCode != http.StatusOK {
		t.Fatalf("commit 1 failed status=%d body=%s", cResp1.StatusCode, cRaw1)
	}
	var c1 struct {
		ServerSeq uint64 `json:"server_seq"`
	}
	_ = json.Unmarshal(cRaw1, &c1)
	if c1.ServerSeq != 1 {
		t.Fatalf("expected server_seq=1, got %d", c1.ServerSeq)
	}

	// Idempotent duplicate commit MUST return server_seq=1 without charging quota twice!
	cRespDup, cRawDup := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/commit", tokenA, commitPayload)
	if cRespDup.StatusCode != http.StatusOK {
		t.Fatalf("idempotent commit failed status=%d body=%s", cRespDup.StatusCode, cRawDup)
	}
	var cDup struct {
		ServerSeq uint64 `json:"server_seq"`
	}
	_ = json.Unmarshal(cRawDup, &cDup)
	if cDup.ServerSeq != 1 {
		t.Fatalf("expected idempotent server_seq=1, got %d", cDup.ServerSeq)
	}

	// 9. Upload Pack 2 (1040B, total 2080B <= 2500B quota) -> server_seq = 2!
	ct2 := make([]byte, 1040)
	_, _ = rand.Read(ct2)
	b3_2 := blake3.Sum256(ct2)
	sha2 := sha256.Sum256(ct2)
	pack2ID := hex.EncodeToString(b3_2[:])
	sha2Hex := hex.EncodeToString(sha2[:])
	aad2 := aad
	aad2.FirstSeq = 3
	aad2.LastSeq = 4

	_, rawP2 := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/presign", tokenA, map[string]any{
		"pack_id":        pack2ID,
		"content_length": len(ct2),
		"sha256_hex":     sha2Hex,
	})
	var p2 struct {
		UploadID        string            `json:"upload_id"`
		PutURL          string            `json:"put_url"`
		RequiredHeaders map[string]string `json:"required_headers"`
	}
	_ = json.Unmarshal(rawP2, &p2)
	reqP2, _ := http.NewRequest(http.MethodPut, p2.PutURL, bytes.NewReader(ct2))
	reqP2.ContentLength = int64(len(ct2))
	for k, v := range p2.RequiredHeaders {
		reqP2.Header.Set(k, v)
	}
	respP2, _ := client.Do(reqP2)
	_ = respP2.Body.Close()

	cResp2, cRaw2 := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/commit", tokenA, map[string]any{
		"upload_id":          p2.UploadID,
		"pack_id":            pack2ID,
		"aad":                aad2,
		"aad_utf8":           aad2.CanonicalJSON(),
		"dek_wrap_nonce_hex": vec.Packfile.DEKWrapNonceHex,
		"wrapped_dek_hex":    vec.Packfile.WrappedDEKHex,
		"pack_nonce_hex":     vec.Packfile.PackNonceHex,
		"content_length":     len(ct2),
		"sha256_hex":         sha2Hex,
	})
	if cResp2.StatusCode != http.StatusOK {
		t.Fatalf("commit 2 failed status=%d body=%s", cResp2.StatusCode, cRaw2)
	}
	var c2 struct {
		ServerSeq uint64 `json:"server_seq"`
	}
	_ = json.Unmarshal(cRaw2, &c2)
	if c2.ServerSeq != 2 {
		t.Fatalf("expected server_seq=2, got %d", c2.ServerSeq)
	}

	// 10. Per-Agent Quota Overrun on Pack 3 (2080 + 1040 = 3120 > 2500) -> MUST reject with 413 or 429!
	ct3 := make([]byte, 1040)
	_, _ = rand.Read(ct3)
	b3_3 := blake3.Sum256(ct3)
	sha3 := sha256.Sum256(ct3)
	qResp, qRaw := doJSON(t, client, http.MethodPost, srv.URL+"/v1/spine/"+agentA+"/packs/presign", tokenA, map[string]any{
		"pack_id":        hex.EncodeToString(b3_3[:]),
		"content_length": len(ct3),
		"sha256_hex":     hex.EncodeToString(sha3[:]),
	})
	if qResp.StatusCode != http.StatusRequestEntityTooLarge && qResp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected quota overrun to return 413 or 429, got %d (%s)", qResp.StatusCode, qRaw)
	}

	// 11. GET /v1/spine/{agent_id}/packs?after_seq=0&limit=10 + Download via Presigned GET URL
	listResp, listRaw := doJSON(t, client, http.MethodGet, srv.URL+"/v1/spine/"+agentA+"/packs?after_seq=0&limit=10", tokenA, nil)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list packs failed status=%d body=%s", listResp.StatusCode, listRaw)
	}
	var listed struct {
		Packs []store.SpinePackRecord `json:"packs"`
	}
	_ = json.Unmarshal(listRaw, &listed)
	if len(listed.Packs) != 2 || listed.Packs[0].ServerSeq != 1 || listed.Packs[1].ServerSeq != 2 {
		t.Fatalf("expected 2 ordered packs [1, 2], got %+v", listed.Packs)
	}
	dlResp, err := client.Get(listed.Packs[0].DownloadURL)
	if err != nil {
		t.Fatalf("download pack 1: %v", err)
	}
	dlBytes, _ := io.ReadAll(dlResp.Body)
	_ = dlResp.Body.Close()
	if !bytes.Equal(dlBytes, ciphertext) {
		t.Fatalf("downloaded pack 1 ciphertext mismatch")
	}

	// 12. Cross-Account 403 Forbidden IDOR on Spine endpoints!
	for _, tc := range []struct {
		method string
		url    string
		body   any
	}{
		{http.MethodGet, srv.URL + "/v1/spine/" + agentA + "/packs?after_seq=0&limit=10", nil},
		{http.MethodPost, srv.URL + "/v1/spine/" + agentA + "/packs/presign", map[string]any{
			"pack_id":        vec.Packfile.PackIDBlake3Hex,
			"content_length": len(ciphertext),
			"sha256_hex":     ctSHAHex,
		}},
		{http.MethodPost, srv.URL + "/v1/spine/" + agentA + "/packs/commit", commitPayload},
	} {
		r, b := doJSON(t, client, tc.method, tc.url, tokenB, tc.body)
		if r.StatusCode != http.StatusForbidden {
			t.Fatalf("Spine IDOR %s %s expected 403 Forbidden, got %d (%s)", tc.method, tc.url, r.StatusCode, b)
		}
	}

	// 13. Zero-Knowledge Canary Scan on DB & Blob files for plaintext Spine event summary!
	canaryPlain := []byte("记录单写者脊柱测试事件")
	_ = filepath.Walk(filepath.Dir(blobDir), func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		b, readErr := os.ReadFile(path)
		if readErr == nil && bytes.Contains(b, canaryPlain) {
			t.Fatalf("ZERO-KNOWLEDGE VIOLATION: plaintext spine memory found in %s", path)
		}
		return nil
	})
	_ = dbPath
}

func TestCASWitnessEpochConcurrencyVoluntaryHandoffAndStaleRejection(t *testing.T) {
	srv, st, clk, _, _ := setupTestHub(t, 10*1024*1024)
	client := srv.Client()

	const agentA = "018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f"
	const dev0 = "00000000-0000-4000-8000-000000000000"
	tokenA, rootSeedA := registerPasskeyAgent(t, client, srv.URL, agentA, dev0)

	const numContenders = 32
	devIDs := make([]string, numContenders)
	devTokens := make([]string, numContenders)
	devIDs[0] = dev0
	devTokens[0] = tokenA

	// Register 31 additional authorized devices on Agent A via root-signed membership
	for i := 1; i < numContenders; i++ {
		devID := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
		devIDs[i] = devID
		pub, _, _ := ed25519.GenerateKey(rand.Reader)
		var pubArr [32]byte
		copy(pubArr[:], pub)
		xw, _ := auth.GenerateXWingKeyPair()
		xwPK := xw.PublicKeyBytes()
		sig, xwB3Hex, err := auth.SignMembershipChange(rootSeedA, agentA, 1, "add_device", devID, pubArr, xwPK[:])
		if err != nil {
			t.Fatalf("SignMembershipChange dev %d: %v", i, err)
		}
		resp, raw := doJSON(t, client, http.MethodPost, srv.URL+"/v1/auth/devices", tokenA, map[string]any{
			"agent_id":                agentA,
			"epoch":                   1,
			"device_id":               devID,
			"ed25519_pubkey_hex":      hex.EncodeToString(pub),
			"xwing_pubkey_hex":        hex.EncodeToString(xwPK[:]),
			"xwing_pubkey_blake3_hex": xwB3Hex,
			"root_signature_hex":      hex.EncodeToString(sig[:]),
		})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("add device %d status=%d body=%s", i, resp.StatusCode, raw)
		}
		var dResp struct {
			SessionToken string `json:"session_token"`
		}
		_ = json.Unmarshal(raw, &dResp)
		devTokens[i] = dResp.SessionToken
	}

	// --- Wave 1: 32-goroutine simultaneous CAS contention! ---
	startBarrier := make(chan struct{})
	var wg sync.WaitGroup
	var winCount atomic.Int32
	var conflictCount atomic.Int32
	var winnerIdx atomic.Int32
	winnerIdx.Store(-1)

	for i := 0; i < numContenders; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startBarrier
			r, body := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/acquire", devTokens[idx], map[string]any{
				"agent_id":  agentA,
				"device_id": devIDs[idx],
				"ttl_ms":    30_000,
			})
			switch r.StatusCode {
			case http.StatusOK:
				var lr store.LeaseRecord
				_ = json.Unmarshal(body, &lr)
				if lr.WitnessEpoch == 1 {
					winCount.Add(1)
					winnerIdx.Store(int32(idx))
				}
			case http.StatusConflict:
				if bytes.Contains(body, []byte("STALE_LEASE_EPOCH")) {
					conflictCount.Add(1)
				}
			}
		}(i)
	}
	close(startBarrier)
	wg.Wait()

	if winCount.Load() != 1 || conflictCount.Load() != numContenders-1 {
		t.Fatalf("32-way CAS wave 1 expected 1 winner & 31 STALE_LEASE_EPOCH conflicts, got wins=%d conflicts=%d", winCount.Load(), conflictCount.Load())
	}

	w1 := int(winnerIdx.Load())
	standby := (w1 + 1) % numContenders

	// Active holder renews at SAME witness_epoch == 1
	clk.Advance(10 * time.Second)
	renResp, renRaw := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/renew", devTokens[w1], map[string]any{
		"agent_id":      agentA,
		"device_id":     devIDs[w1],
		"witness_epoch": 1,
		"ttl_ms":        30_000,
	})
	if renResp.StatusCode != http.StatusOK {
		t.Fatalf("holder renew failed status=%d body=%s", renResp.StatusCode, renRaw)
	}
	var renRec store.LeaseRecord
	_ = json.Unmarshal(renRaw, &renRec)
	if renRec.WitnessEpoch != 1 {
		t.Fatalf("expected renew to preserve witness_epoch=1, got %d", renRec.WitnessEpoch)
	}

	// Non-holder attempting to release MUST fail with 409 STALE_LEASE_EPOCH!
	badRel, badRelBody := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/release", devTokens[standby], map[string]any{
		"agent_id":      agentA,
		"device_id":     devIDs[standby],
		"witness_epoch": 1,
	})
	if badRel.StatusCode != http.StatusConflict || !bytes.Contains(badRelBody, []byte("STALE_LEASE_EPOCH")) {
		t.Fatalf("expected non-holder release to return 409 STALE_LEASE_EPOCH, got %d (%s)", badRel.StatusCode, badRelBody)
	}

	// --- Voluntary Release & <100ms Zero-Wait Handoff to witness_epoch == 2! ---
	handoffStart := time.Now()
	relResp, relBody := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/release", devTokens[w1], map[string]any{
		"agent_id":      agentA,
		"device_id":     devIDs[w1],
		"witness_epoch": 1,
	})
	if relResp.StatusCode != http.StatusOK {
		t.Fatalf("voluntary release failed status=%d body=%s", relResp.StatusCode, relBody)
	}
	acq2Resp, acq2Body := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/acquire", devTokens[standby], map[string]any{
		"agent_id":  agentA,
		"device_id": devIDs[standby],
		"ttl_ms":    30_000,
	})
	handoffElapsed := time.Since(handoffStart)
	if acq2Resp.StatusCode != http.StatusOK {
		t.Fatalf("standby handoff acquire failed status=%d body=%s", acq2Resp.StatusCode, acq2Body)
	}
	if handoffElapsed >= 100*time.Millisecond {
		t.Fatalf("expected voluntary lease handoff < 100ms, took %v", handoffElapsed)
	}
	var lr2 store.LeaseRecord
	_ = json.Unmarshal(acq2Body, &lr2)
	if lr2.WitnessEpoch != 2 || lr2.HolderDeviceID != devIDs[standby] {
		t.Fatalf("expected standby to hold witness_epoch=2, got %+v", lr2)
	}

	// --- Old Holder Wake-Up Presenting Stale witness_epoch=1 MUST Fail with 409 STALE_LEASE_EPOCH! ---
	for _, endpoint := range []struct {
		path string
		body map[string]any
	}{
		{"/v1/lease/renew", map[string]any{"agent_id": agentA, "device_id": devIDs[w1], "witness_epoch": 1, "ttl_ms": 30_000}},
		{"/v1/lease/release", map[string]any{"agent_id": agentA, "device_id": devIDs[w1], "witness_epoch": 1}},
		{"/v1/lease/acquire", map[string]any{"agent_id": agentA, "device_id": devIDs[w1], "expected_epoch": 1, "ttl_ms": 30_000}},
	} {
		stResp, stBody := doJSON(t, client, http.MethodPost, srv.URL+endpoint.path, devTokens[w1], endpoint.body)
		if stResp.StatusCode != http.StatusConflict || !bytes.Contains(stBody, []byte("STALE_LEASE_EPOCH")) {
			t.Fatalf("stale %s expected 409 STALE_LEASE_EPOCH, got %d (%s)", endpoint.path, stResp.StatusCode, stBody)
		}
	}

	// --- Wave 2: TTL Expiry + 32-Goroutine Contention for witness_epoch == 3! ---
	clk.Advance(35 * time.Second)
	startBarrier2 := make(chan struct{})
	winCount.Store(0)
	conflictCount.Store(0)
	for i := 0; i < numContenders; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startBarrier2
			r, body := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/acquire", devTokens[idx], map[string]any{
				"agent_id":  agentA,
				"device_id": devIDs[idx],
				"ttl_ms":    30_000,
			})
			switch r.StatusCode {
			case http.StatusOK:
				var lr store.LeaseRecord
				_ = json.Unmarshal(body, &lr)
				if lr.WitnessEpoch == 3 {
					winCount.Add(1)
				}
			case http.StatusConflict:
				if bytes.Contains(body, []byte("STALE_LEASE_EPOCH")) {
					conflictCount.Add(1)
				}
			}
		}(i)
	}
	close(startBarrier2)
	wg.Wait()

	if winCount.Load() != 1 || conflictCount.Load() != numContenders-1 {
		t.Fatalf("32-way CAS wave 2 after TTL expiry expected 1 winner at epoch=3 & 31 conflicts, got wins=%d conflicts=%d", winCount.Load(), conflictCount.Load())
	}

	// --- Cross-Account 403 Forbidden on Lease Endpoints! ---
	const agentOther = "778f4a90-7c20-4d31-8b12-9a0b1c2d3e77"
	const devOther = "77020304-0506-8708-890a-0b0c0d0e0f77"
	tokenOther, _ := registerPasskeyAgent(t, client, srv.URL, agentOther, devOther)
	rForbid, bForbid := doJSON(t, client, http.MethodPost, srv.URL+"/v1/lease/acquire", tokenOther, map[string]any{
		"agent_id":  agentA,
		"device_id": devOther,
		"ttl_ms":    30_000,
	})
	if rForbid.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-account lease acquire expected 403 Forbidden, got %d (%s)", rForbid.StatusCode, bForbid)
	}
	_ = context.Background()
	_ = st
}

func extractSchemaTablesAndColumns(ddl string) map[string][]string {
	re := regexp.MustCompile(`(?s)CREATE TABLE IF NOT EXISTS ([a-z_]+)\s*\((.*?)\);`)
	matches := re.FindAllStringSubmatch(ddl, -1)
	out := make(map[string][]string, len(matches))
	for _, m := range matches {
		tbl := m[1]
		lines := strings.Split(m[2], "\n")
		var cols []string
		for _, line := range lines {
			trimmed := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), ","))
			if trimmed == "" || strings.HasPrefix(strings.ToUpper(trimmed), "PRIMARY KEY") || strings.HasPrefix(strings.ToUpper(trimmed), "UNIQUE") {
				continue
			}
			fields := strings.Fields(trimmed)
			if len(fields) > 0 {
				cols = append(cols, fields[0])
			}
		}
		out[tbl] = cols
	}
	return out
}

func TestSQLiteAndPostgresSchemaParity(t *testing.T) {
	sqDDL, pgDDL := store.SchemaDDLForParityTest()
	sqTables := extractSchemaTablesAndColumns(sqDDL)
	pgTables := extractSchemaTablesAndColumns(pgDDL)
	if len(sqTables) == 0 || len(sqTables) != len(pgTables) {
		t.Fatalf("schema table count mismatch: sqlite=%d postgres=%d", len(sqTables), len(pgTables))
	}
	for tbl, sqCols := range sqTables {
		pgCols, ok := pgTables[tbl]
		if !ok {
			t.Fatalf("table %q exists in SQLite DDL but missing in Postgres DDL", tbl)
		}
		if !slices.Equal(sqCols, pgCols) {
			t.Fatalf("table %q column mismatch:\n sqlite:   %v\n postgres: %v", tbl, sqCols, pgCols)
		}
	}
}

func TestQuetzalcoatlHubBinaryLiveSubprocessE2E(t *testing.T) {
	hubRoot := filepath.Join(findRepoRoot(t), "hub")
	tmpDir := t.TempDir()
	binPath := filepath.Join(tmpDir, "quetzalcoatl-hub")

	buildCmd := exec.Command("go", "build", "-o", binPath, "./cmd/quetzalcoatl-hub")
	buildCmd.Dir = hubRoot
	buildCmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("CGO_ENABLED=0 go build failed: %v\n%s", err, out)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("pick free port: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	baseURL := "http://" + addr
	proc := exec.Command(binPath)
	proc.Env = append(os.Environ(),
		"QUETZALCOATL_HUB_ADDR="+addr,
		"QUETZALCOATL_HUB_PUBLIC_URL="+baseURL,
		"QUETZALCOATL_HUB_DATA_DIR="+filepath.Join(tmpDir, "data"),
		"QUETZALCOATL_HUB_RP_ID=hub.quetzalcoatl.example",
		"QUETZALCOATL_HUB_ALLOWED_ORIGINS=https://hub.quetzalcoatl.example",
	)
	if err := proc.Start(); err != nil {
		t.Fatalf("start quetzalcoatl-hub subprocess: %v", err)
	}
	waited := false
	t.Cleanup(func() {
		if !waited && proc.Process != nil {
			_ = proc.Process.Signal(syscall.SIGTERM)
			_, _ = proc.Process.Wait()
		}
	})

	httpClient := &http.Client{Timeout: 5 * time.Second}
	ready := false
	for i := 0; i < 50; i++ {
		resp, err := httpClient.Get(baseURL + "/healthz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatalf("quetzalcoatl-hub binary did not become healthy on %s", baseURL)
	}

	const agentLive = "558f4a90-7c20-4d31-8b12-9a0b1c2d3e55"
	const devLive = "55020304-0506-8708-890a-0b0c0d0e0f55"
	tok, _ := registerPasskeyAgent(t, httpClient, baseURL, agentLive, devLive)

	lResp, lBody := doJSON(t, httpClient, http.MethodPost, baseURL+"/v1/lease/acquire", tok, map[string]any{
		"agent_id":  agentLive,
		"device_id": devLive,
		"ttl_ms":    15_000,
	})
	if lResp.StatusCode != http.StatusOK {
		t.Fatalf("live binary lease acquire failed: %d (%s)", lResp.StatusCode, lBody)
	}

	if err := proc.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
	state, err := proc.Process.Wait()
	waited = true
	if err != nil || !state.Success() {
		t.Fatalf("expected clean exit 0 on SIGTERM, state=%v err=%v", state, err)
	}
}

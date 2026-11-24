// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"lukechampine.com/blake3"
)

type SigV4Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	UsePathStyle    bool
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(data))
	return mac.Sum(nil)
}

func sigV4SigningKey(secret, dateYYYYMMDD, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), dateYYYYMMDD)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	return hmacSHA256(kService, "aws4_request")
}

func uriEncodeSigV4(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '_' || c == '-' || c == '~' || c == '.' {
			b.WriteByte(c)
		} else if c == '/' && !encodeSlash {
			b.WriteByte('/')
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalQuerySigV4(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, uriEncodeSigV4(k, true)+"="+uriEncodeSigV4(params[k], true))
	}
	return strings.Join(parts, "&")
}

func isLowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func buildSigV4EndpointAndPath(cfg SigV4Config, objectKey string) (*url.URL, string, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, "", errors.New("invalid SigV4 endpoint URL")
	}
	cleanKey := strings.TrimPrefix(objectKey, "/")
	if cleanKey == "" {
		return nil, "", errors.New("empty object key")
	}
	var fullPath string
	if cfg.Bucket == "" {
		fullPath = "/" + cleanKey
	} else if cfg.UsePathStyle {
		fullPath = "/" + cfg.Bucket + "/" + cleanKey
	} else {
		u.Host = cfg.Bucket + "." + u.Host
		fullPath = "/" + cleanKey
	}
	basePath := strings.TrimRight(u.Path, "/")
	if basePath != "" {
		fullPath = basePath + fullPath
	}
	return u, fullPath, nil
}

// PresignSigV4Put generates an AWS SigV4 Presigned PUT URL compatible with AWS S3, Cloudflare R2, and MinIO,
// cryptographically binding exact Content-Length and SHA-256 hex digest (Pitfall #18: NEVER PresignedPostPolicy).
func PresignSigV4Put(cfg SigV4Config, objectKey string, contentLength int64, sha256Hex string, expires time.Duration, now time.Time) (string, map[string]string, error) {
	if contentLength <= 0 {
		return "", nil, errors.New("contentLength must be > 0")
	}
	shaLower := strings.ToLower(sha256Hex)
	if !isLowerHex64(shaLower) {
		return "", nil, errors.New("sha256Hex must be 64 lowercase hex chars")
	}
	expSec := int64(expires / time.Second)
	if expSec <= 0 || expSec > 604800 {
		return "", nil, errors.New("expires out of SigV4 range (1..604800s)")
	}
	region := cfg.Region
	if region == "" {
		region = "auto"
	}
	u, fullPath, err := buildSigV4EndpointAndPath(cfg, objectKey)
	if err != nil {
		return "", nil, err
	}

	utcNow := now.UTC()
	amzDate := utcNow.Format("20060102T150405Z")
	dateShort := utcNow.Format("20060102")
	scope := fmt.Sprintf("%s/%s/s3/aws4_request", dateShort, region)
	signedHeaders := "content-length;host;x-amz-content-sha256"

	qParams := map[string]string{
		"X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
		"X-Amz-Credential":    cfg.AccessKeyID + "/" + scope,
		"X-Amz-Date":          amzDate,
		"X-Amz-Expires":       strconv.FormatInt(expSec, 10),
		"X-Amz-SignedHeaders": signedHeaders,
	}
	canonicalQuery := canonicalQuerySigV4(qParams)
	canonicalURI := uriEncodeSigV4(fullPath, false)
	canonicalHeaders := fmt.Sprintf(
		"content-length:%d\nhost:%s\nx-amz-content-sha256:%s\n",
		contentLength, u.Host, shaLower,
	)

	canonicalReq := strings.Join([]string{
		http.MethodPut,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		shaLower,
	}, "\n")
	reqHash := sha256.Sum256([]byte(canonicalReq))

	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(reqHash[:]),
	}, "\n")
	sigKey := sigV4SigningKey(cfg.SecretAccessKey, dateShort, region, "s3")
	sigHex := hex.EncodeToString(hmacSHA256(sigKey, stringToSign))

	finalURL := fmt.Sprintf("%s://%s%s?%s&X-Amz-Signature=%s", u.Scheme, u.Host, canonicalURI, canonicalQuery, sigHex)
	reqHeaders := map[string]string{
		"Content-Length":       strconv.FormatInt(contentLength, 10),
		"x-amz-content-sha256": shaLower,
	}
	return finalURL, reqHeaders, nil
}

func PresignSigV4Get(cfg SigV4Config, objectKey string, expires time.Duration, now time.Time) (string, error) {
	expSec := int64(expires / time.Second)
	if expSec <= 0 || expSec > 604800 {
		return "", errors.New("expires out of SigV4 range")
	}
	region := cfg.Region
	if region == "" {
		region = "auto"
	}
	u, fullPath, err := buildSigV4EndpointAndPath(cfg, objectKey)
	if err != nil {
		return "", err
	}
	utcNow := now.UTC()
	amzDate := utcNow.Format("20060102T150405Z")
	dateShort := utcNow.Format("20060102")
	scope := fmt.Sprintf("%s/%s/s3/aws4_request", dateShort, region)
	signedHeaders := "host"

	qParams := map[string]string{
		"X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
		"X-Amz-Credential":    cfg.AccessKeyID + "/" + scope,
		"X-Amz-Date":          amzDate,
		"X-Amz-Expires":       strconv.FormatInt(expSec, 10),
		"X-Amz-SignedHeaders": signedHeaders,
	}
	canonicalQuery := canonicalQuerySigV4(qParams)
	canonicalURI := uriEncodeSigV4(fullPath, false)
	canonicalHeaders := fmt.Sprintf("host:%s\n", u.Host)
	canonicalReq := strings.Join([]string{
		http.MethodGet,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		"UNSIGNED-PAYLOAD",
	}, "\n")
	reqHash := sha256.Sum256([]byte(canonicalReq))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(reqHash[:]),
	}, "\n")
	sigKey := sigV4SigningKey(cfg.SecretAccessKey, dateShort, region, "s3")
	sigHex := hex.EncodeToString(hmacSHA256(sigKey, stringToSign))
	return fmt.Sprintf("%s://%s%s?%s&X-Amz-Signature=%s", u.Scheme, u.Host, canonicalURI, canonicalQuery, sigHex), nil
}

func VerifySigV4PresignedPut(r *http.Request, cfg SigV4Config, now time.Time) (string, int64, string, error) {
	if r.Method != http.MethodPut {
		return "", 0, "", errors.New("expected PUT method")
	}
	q := r.URL.Query()
	if q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" {
		return "", 0, "", errors.New("unsupported X-Amz-Algorithm")
	}
	amzDate := q.Get("X-Amz-Date")
	signedAt, err := time.Parse("20060102T150405Z", amzDate)
	if err != nil {
		return "", 0, "", fmt.Errorf("invalid X-Amz-Date: %w", err)
	}
	expSec, err := strconv.ParseInt(q.Get("X-Amz-Expires"), 10, 64)
	if err != nil || expSec <= 0 || expSec > 604800 {
		return "", 0, "", errors.New("invalid X-Amz-Expires")
	}
	utcNow := now.UTC()
	if utcNow.Before(signedAt.Add(-5*time.Minute)) || !utcNow.Before(signedAt.Add(time.Duration(expSec)*time.Second)) {
		return "", 0, "", ErrExpired
	}

	region := cfg.Region
	if region == "" {
		region = "auto"
	}
	dateShort := signedAt.Format("20060102")
	expectedScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateShort, region)
	expectedCred := cfg.AccessKeyID + "/" + expectedScope
	if q.Get("X-Amz-Credential") != expectedCred {
		return "", 0, "", errors.New("X-Amz-Credential mismatch")
	}
	if q.Get("X-Amz-SignedHeaders") != "content-length;host;x-amz-content-sha256" {
		return "", 0, "", errors.New("X-Amz-SignedHeaders must bind content-length;host;x-amz-content-sha256")
	}

	contentLen := r.ContentLength
	if hdrLen := r.Header.Get("Content-Length"); hdrLen != "" {
		parsedLen, err := strconv.ParseInt(hdrLen, 10, 64)
		if err != nil {
			return "", 0, "", errors.New("invalid Content-Length header")
		}
		if contentLen > 0 && contentLen != parsedLen {
			return "", 0, "", errors.New("conflicting Content-Length")
		}
		contentLen = parsedLen
	}
	if contentLen <= 0 {
		return "", 0, "", errors.New("missing or non-positive Content-Length")
	}
	shaHeader := strings.ToLower(r.Header.Get("x-amz-content-sha256"))
	if !isLowerHex64(shaHeader) {
		return "", 0, "", errors.New("missing or invalid x-amz-content-sha256 digest")
	}
	host := r.Host
	if host == "" && r.URL != nil {
		host = r.URL.Host
	}
	if host == "" {
		return "", 0, "", errors.New("missing request Host")
	}

	qParams := map[string]string{
		"X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
		"X-Amz-Credential":    expectedCred,
		"X-Amz-Date":          amzDate,
		"X-Amz-Expires":       strconv.FormatInt(expSec, 10),
		"X-Amz-SignedHeaders": "content-length;host;x-amz-content-sha256",
	}
	canonicalQuery := canonicalQuerySigV4(qParams)
	canonicalURI := uriEncodeSigV4(r.URL.Path, false)
	canonicalHeaders := fmt.Sprintf(
		"content-length:%d\nhost:%s\nx-amz-content-sha256:%s\n",
		contentLen, host, shaHeader,
	)
	canonicalReq := strings.Join([]string{
		http.MethodPut,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders,
		"content-length;host;x-amz-content-sha256",
		shaHeader,
	}, "\n")
	reqHash := sha256.Sum256([]byte(canonicalReq))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		expectedScope,
		hex.EncodeToString(reqHash[:]),
	}, "\n")
	sigKey := sigV4SigningKey(cfg.SecretAccessKey, dateShort, region, "s3")
	expectedSig := hex.EncodeToString(hmacSHA256(sigKey, stringToSign))
	providedSig := strings.ToLower(q.Get("X-Amz-Signature"))
	if len(providedSig) != len(expectedSig) || subtle.ConstantTimeCompare([]byte(providedSig), []byte(expectedSig)) != 1 {
		return "", 0, "", errors.New("SigV4 signature mismatch")
	}

	objKey := strings.TrimPrefix(r.URL.Path, "/")
	if cfg.Bucket != "" && cfg.UsePathStyle && strings.HasPrefix(objKey, cfg.Bucket+"/") {
		objKey = strings.TrimPrefix(objKey, cfg.Bucket+"/")
	}
	return objKey, contentLen, shaHeader, nil
}

func verifySigV4PresignedGet(r *http.Request, cfg SigV4Config, now time.Time) (string, error) {
	if r.Method != http.MethodGet {
		return "", errors.New("expected GET method")
	}
	q := r.URL.Query()
	if q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" {
		return "", errors.New("unsupported X-Amz-Algorithm")
	}
	amzDate := q.Get("X-Amz-Date")
	signedAt, err := time.Parse("20060102T150405Z", amzDate)
	if err != nil {
		return "", err
	}
	expSec, err := strconv.ParseInt(q.Get("X-Amz-Expires"), 10, 64)
	if err != nil || expSec <= 0 || expSec > 604800 {
		return "", errors.New("invalid X-Amz-Expires")
	}
	utcNow := now.UTC()
	if utcNow.Before(signedAt.Add(-5*time.Minute)) || !utcNow.Before(signedAt.Add(time.Duration(expSec)*time.Second)) {
		return "", ErrExpired
	}
	region := cfg.Region
	if region == "" {
		region = "auto"
	}
	dateShort := signedAt.Format("20060102")
	expectedScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateShort, region)
	expectedCred := cfg.AccessKeyID + "/" + expectedScope
	if q.Get("X-Amz-Credential") != expectedCred || q.Get("X-Amz-SignedHeaders") != "host" {
		return "", errors.New("invalid SigV4 GET credential/headers")
	}
	host := r.Host
	if host == "" && r.URL != nil {
		host = r.URL.Host
	}
	qParams := map[string]string{
		"X-Amz-Algorithm":     "AWS4-HMAC-SHA256",
		"X-Amz-Credential":    expectedCred,
		"X-Amz-Date":          amzDate,
		"X-Amz-Expires":       strconv.FormatInt(expSec, 10),
		"X-Amz-SignedHeaders": "host",
	}
	canonicalReq := strings.Join([]string{
		http.MethodGet,
		uriEncodeSigV4(r.URL.Path, false),
		canonicalQuerySigV4(qParams),
		fmt.Sprintf("host:%s\n", host),
		"host",
		"UNSIGNED-PAYLOAD",
	}, "\n")
	reqHash := sha256.Sum256([]byte(canonicalReq))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		expectedScope,
		hex.EncodeToString(reqHash[:]),
	}, "\n")
	sigKey := sigV4SigningKey(cfg.SecretAccessKey, dateShort, region, "s3")
	expectedSig := hex.EncodeToString(hmacSHA256(sigKey, stringToSign))
	providedSig := strings.ToLower(q.Get("X-Amz-Signature"))
	if len(providedSig) != len(expectedSig) || subtle.ConstantTimeCompare([]byte(providedSig), []byte(expectedSig)) != 1 {
		return "", errors.New("SigV4 GET signature mismatch")
	}
	return strings.TrimPrefix(r.URL.Path, "/"), nil
}

type BlobMetadata struct {
	BlobKey       string
	ContentLength int64
	SHA256Hex     string
	Blake3Hex     string
}

type BlobStore interface {
	PresignPut(ctx context.Context, uploadID, blobKey string, contentLength int64, sha256Hex string, expires time.Duration, now time.Time) (string, map[string]string, error)
	PresignGet(ctx context.Context, blobKey string, expires time.Duration, now time.Time) (string, error)
	StatVerifiedBlob(ctx context.Context, blobKey string) (*BlobMetadata, error)
	DeleteBlobs(ctx context.Context, blobKeys []string) error
	RegisterRoutes(mux *http.ServeMux)
}

type LocalBlobStore struct {
	rootDir string
	sigCfg  SigV4Config
	store   Store
	clock   func() time.Time
}

var _ BlobStore = (*LocalBlobStore)(nil)

func NewLocalBlobStore(rootDir, publicBaseURL string, hmacSecret [32]byte, st Store, clock func() time.Time) (*LocalBlobStore, error) {
	if err := os.MkdirAll(filepath.Join(rootDir, ".tmp"), 0o700); err != nil {
		return nil, fmt.Errorf("init local blob dir: %w", err)
	}
	if clock == nil {
		clock = time.Now
	}
	return &LocalBlobStore{
		rootDir: rootDir,
		sigCfg: SigV4Config{
			Endpoint:        strings.TrimRight(publicBaseURL, "/"),
			Region:          "auto",
			Bucket:          "",
			AccessKeyID:     "quetzalcoatl-hub-local",
			SecretAccessKey: hex.EncodeToString(hmacSecret[:]),
			UsePathStyle:    false,
		},
		store: st,
		clock: clock,
	}, nil
}

func sanitizeRelBlobKey(blobKey string) (string, error) {
	cleaned := filepath.Clean(strings.TrimPrefix(blobKey, "/"))
	if cleaned == "." || cleaned == "" || strings.HasPrefix(cleaned, "..") || filepath.IsAbs(cleaned) {
		return "", errors.New("invalid blob key")
	}
	return cleaned, nil
}

func (b *LocalBlobStore) blobDiskPath(blobKey string) (string, error) {
	rel, err := sanitizeRelBlobKey(blobKey)
	if err != nil {
		return "", err
	}
	full := filepath.Join(b.rootDir, rel)
	relCheck, err := filepath.Rel(b.rootDir, full)
	if err != nil || strings.HasPrefix(relCheck, "..") {
		return "", errors.New("blob path traversal blocked")
	}
	return full, nil
}

func (b *LocalBlobStore) PresignPut(ctx context.Context, uploadID, blobKey string, contentLength int64, sha256Hex string, expires time.Duration, now time.Time) (string, map[string]string, error) {
	_ = ctx
	_ = blobKey
	return PresignSigV4Put(b.sigCfg, "v1/blobs/put/"+uploadID, contentLength, sha256Hex, expires, now)
}

func (b *LocalBlobStore) PresignGet(ctx context.Context, blobKey string, expires time.Duration, now time.Time) (string, error) {
	_ = ctx
	rel, err := sanitizeRelBlobKey(blobKey)
	if err != nil {
		return "", err
	}
	return PresignSigV4Get(b.sigCfg, "v1/blobs/get/"+filepath.ToSlash(rel), expires, now)
}

func (b *LocalBlobStore) StatVerifiedBlob(ctx context.Context, blobKey string) (*BlobMetadata, error) {
	_ = ctx
	diskPath, err := b.blobDiskPath(blobKey)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(diskPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer f.Close()

	shaH := sha256.New()
	b3H := blake3.New(32, nil)
	n, err := io.Copy(io.MultiWriter(shaH, b3H), f)
	if err != nil {
		return nil, err
	}
	return &BlobMetadata{
		BlobKey:       blobKey,
		ContentLength: n,
		SHA256Hex:     hex.EncodeToString(shaH.Sum(nil)),
		Blake3Hex:     hex.EncodeToString(b3H.Sum(nil)),
	}, nil
}

func (b *LocalBlobStore) DeleteBlobs(ctx context.Context, blobKeys []string) error {
	_ = ctx
	for _, k := range blobKeys {
		p, err := b.blobDiskPath(k)
		if err != nil {
			continue
		}
		_ = os.Remove(p)
	}
	return nil
}

func writeBlobJSONError(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"code":   code,
		"detail": detail,
	})
}

func (b *LocalBlobStore) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /v1/blobs/put/{upload_id}", b.handlePut)
	mux.HandleFunc("GET /v1/blobs/get/{blob_key...}", b.handleGet)
}

func (b *LocalBlobStore) handlePut(w http.ResponseWriter, r *http.Request) {
	now := b.clock()
	uploadID := r.PathValue("upload_id")
	if uploadID == "" {
		writeBlobJSONError(w, http.StatusBadRequest, "INVALID_ID", "missing upload_id")
		return
	}
	_, signedLen, signedSHA, err := VerifySigV4PresignedPut(r, b.sigCfg, now)
	if err != nil {
		writeBlobJSONError(w, http.StatusForbidden, "INTEGRITY_VIOLATION", err.Error())
		return
	}

	up, err := b.store.GetPackUpload(r.Context(), uploadID)
	if err != nil {
		writeBlobJSONError(w, http.StatusNotFound, "INVALID_ID", "upload session not found")
		return
	}
	if up.ExpiresAtMs <= now.UnixMilli() {
		writeBlobJSONError(w, http.StatusForbidden, "CREDENTIAL_REJECTED", "upload session expired")
		return
	}
	if signedLen != up.ContentLength || signedSHA != up.SHA256Hex {
		writeBlobJSONError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "signed metadata mismatch")
		return
	}

	destPath, err := b.blobDiskPath(up.BlobKey)
	if err != nil {
		writeBlobJSONError(w, http.StatusBadRequest, "INVALID_ID", err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o700); err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}

	tmpFile, err := os.CreateTemp(filepath.Join(b.rootDir, ".tmp"), "upload-*.part")
	if err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	tmpPath := tmpFile.Name()
	committed := false
	defer func() {
		_ = tmpFile.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()

	shaH := sha256.New()
	b3H := blake3.New(32, nil)
	written, copyErr := io.Copy(io.MultiWriter(tmpFile, shaH, b3H), io.LimitReader(r.Body, up.ContentLength+1))
	if copyErr != nil {
		writeBlobJSONError(w, http.StatusBadRequest, "STORAGE_ERROR", copyErr.Error())
		return
	}
	if written != up.ContentLength {
		writeBlobJSONError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION",
			fmt.Sprintf("exact Content-Length mismatch: expected %d, read %d", up.ContentLength, written))
		return
	}
	actualSHA := hex.EncodeToString(shaH.Sum(nil))
	if actualSHA != up.SHA256Hex {
		writeBlobJSONError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "SHA-256 digest mismatch")
		return
	}
	actualBlake3 := hex.EncodeToString(b3H.Sum(nil))
	if actualBlake3 != strings.ToLower(up.PackID) {
		writeBlobJSONError(w, http.StatusUnprocessableEntity, "INTEGRITY_VIOLATION", "BLAKE3 pack_id mismatch")
		return
	}

	if err := tmpFile.Sync(); err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := tmpFile.Close(); err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	committed = true

	if err := b.store.MarkPackUploaded(r.Context(), uploadID); err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"upload_id":      uploadID,
		"content_length": written,
		"sha256_hex":     actualSHA,
	})
}

func (b *LocalBlobStore) handleGet(w http.ResponseWriter, r *http.Request) {
	if _, err := verifySigV4PresignedGet(r, b.sigCfg, b.clock()); err != nil {
		writeBlobJSONError(w, http.StatusForbidden, "CREDENTIAL_REJECTED", err.Error())
		return
	}
	blobKey := r.PathValue("blob_key")
	diskPath, err := b.blobDiskPath(blobKey)
	if err != nil {
		writeBlobJSONError(w, http.StatusBadRequest, "INVALID_ID", err.Error())
		return
	}
	f, err := os.Open(diskPath)
	if err != nil {
		writeBlobJSONError(w, http.StatusNotFound, "STORAGE_ERROR", "blob not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeBlobJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// S3BlobStore implements BlobStore for external S3-compatible object storage (Cloudflare R2 / MinIO / AWS S3).
type S3BlobStore struct {
	cfg    SigV4Config
	client *http.Client
	clock  func() time.Time
}

var _ BlobStore = (*S3BlobStore)(nil)

func NewS3BlobStore(cfg SigV4Config, client *http.Client, clock func() time.Time) (*S3BlobStore, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, errors.New("incomplete S3 configuration")
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	if clock == nil {
		clock = time.Now
	}
	return &S3BlobStore{cfg: cfg, client: client, clock: clock}, nil
}

func (s *S3BlobStore) PresignPut(ctx context.Context, uploadID, blobKey string, contentLength int64, sha256Hex string, expires time.Duration, now time.Time) (string, map[string]string, error) {
	_ = ctx
	_ = uploadID
	return PresignSigV4Put(s.cfg, blobKey, contentLength, sha256Hex, expires, now)
}

func (s *S3BlobStore) PresignGet(ctx context.Context, blobKey string, expires time.Duration, now time.Time) (string, error) {
	_ = ctx
	return PresignSigV4Get(s.cfg, blobKey, expires, now)
}

func (s *S3BlobStore) StatVerifiedBlob(ctx context.Context, blobKey string) (*BlobMetadata, error) {
	getURL, err := PresignSigV4Get(s.cfg, blobKey, 5*time.Minute, s.clock())
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, getURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("s3 verify GET status %d", resp.StatusCode)
	}
	shaH := sha256.New()
	b3H := blake3.New(32, nil)
	n, err := io.Copy(io.MultiWriter(shaH, b3H), io.LimitReader(resp.Body, 32*1024*1024))
	if err != nil {
		return nil, err
	}
	return &BlobMetadata{
		BlobKey:       blobKey,
		ContentLength: n,
		SHA256Hex:     hex.EncodeToString(shaH.Sum(nil)),
		Blake3Hex:     hex.EncodeToString(b3H.Sum(nil)),
	}, nil
}

func (s *S3BlobStore) DeleteBlobs(ctx context.Context, blobKeys []string) error {
	_ = ctx
	_ = blobKeys
	return nil
}

func (s *S3BlobStore) RegisterRoutes(mux *http.ServeMux) {
	_ = mux
}

// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/lease"
	"quetzalcoatl-hub/internal/llmproxy"
	"quetzalcoatl-hub/internal/relay"
	"quetzalcoatl-hub/internal/spine"
	"quetzalcoatl-hub/internal/store"
)

func envOrDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt64OrDefault(key string, def int64) int64 {
	if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed >= 0 {
			return parsed
		}
	}
	return def
}

type persistedHubSecrets struct {
	HMACSecretHex          string `json:"hmac_secret_hex"`
	OPRFSeedHex            string `json:"oprf_seed_hex"`
	OpaquePrivateScalarHex string `json:"opaque_private_scalar_hex"`
}

func parseHex32Strict(label, raw string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(strings.TrimSpace(raw))
	if err != nil || len(b) != 32 {
		return out, fmt.Errorf("%s must be 64 hex chars (32 bytes)", label)
	}
	copy(out[:], b)
	return out, nil
}

func writeFileAtomic(dir, pattern, targetPath string, perm os.FileMode, data []byte) error {
	tmpFile, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	if err := tmpFile.Chmod(perm); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func loadOrPersistHubSecrets(dataDir string) ([32]byte, [32]byte, [32]byte, error) {
	var hmacSecret, oprfSeed, opaqueScalar [32]byte
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return hmacSecret, oprfSeed, opaqueScalar, fmt.Errorf("create dataDir: %w", err)
	}
	secretsPath := filepath.Join(dataDir, "hub_secrets.json")

	var disk persistedHubSecrets
	rawDisk, readErr := os.ReadFile(secretsPath)
	if readErr == nil {
		if err := json.Unmarshal(rawDisk, &disk); err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, fmt.Errorf("parse %s: %w", secretsPath, err)
		}
		if err := os.Chmod(secretsPath, 0o600); err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, fmt.Errorf("chmod 0600 %s: %w", secretsPath, err)
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return hmacSecret, oprfSeed, opaqueScalar, fmt.Errorf("read %s: %w", secretsPath, errOrNil(readErr))
	} else {
		if _, err := rand.Read(hmacSecret[:]); err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
		if _, err := rand.Read(oprfSeed[:]); err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
		sc, err := auth.GenerateOpaqueServerScalar()
		if err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
		opaqueScalar = sc
		disk = persistedHubSecrets{
			HMACSecretHex:          hex.EncodeToString(hmacSecret[:]),
			OPRFSeedHex:            hex.EncodeToString(oprfSeed[:]),
			OpaquePrivateScalarHex: hex.EncodeToString(opaqueScalar[:]),
		}
		encoded, err := json.MarshalIndent(disk, "", "  ")
		if err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
		if err := writeFileAtomic(dataDir, ".hub_secrets.*.tmp", secretsPath, 0o600, encoded); err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
	}

	var err error
	hmacSecret, err = parseHex32Strict("hub_secrets.hmac_secret_hex", disk.HMACSecretHex)
	if err != nil {
		return hmacSecret, oprfSeed, opaqueScalar, err
	}
	oprfSeed, err = parseHex32Strict("hub_secrets.oprf_seed_hex", disk.OPRFSeedHex)
	if err != nil {
		return hmacSecret, oprfSeed, opaqueScalar, err
	}
	opaqueScalar, err = parseHex32Strict("hub_secrets.opaque_private_scalar_hex", disk.OpaquePrivateScalarHex)
	if err != nil {
		return hmacSecret, oprfSeed, opaqueScalar, err
	}

	// Explicit environment variables override persisted defaults when set
	if envHMAC := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_HMAC_SECRET_HEX")); envHMAC != "" {
		hmacSecret, err = parseHex32Strict("QUETZALCOATL_HUB_HMAC_SECRET_HEX", envHMAC)
		if err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
	}
	if envOPRF := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_OPRF_SEED_HEX")); envOPRF != "" {
		oprfSeed, err = parseHex32Strict("QUETZALCOATL_HUB_OPRF_SEED_HEX", envOPRF)
		if err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
	}
	if envScalar := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_OPAQUE_PRIVATE_SCALAR_HEX")); envScalar != "" {
		opaqueScalar, err = parseHex32Strict("QUETZALCOATL_HUB_OPAQUE_PRIVATE_SCALAR_HEX", envScalar)
		if err != nil {
			return hmacSecret, oprfSeed, opaqueScalar, err
		}
	}
	if err := auth.ValidateOpaqueServerScalar(opaqueScalar); err != nil {
		return hmacSecret, oprfSeed, opaqueScalar, err
	}
	return hmacSecret, oprfSeed, opaqueScalar, nil
}

func loadOrPersistTLSConfig(dataDir, publicURL, certFile, keyFile string) (*tls.Config, error) {
	if certFile != "" || keyFile != "" {
		if certFile == "" || keyFile == "" {
			return nil, errors.New("both QUETZALCOATL_HUB_TLS_CERT_FILE and QUETZALCOATL_HUB_TLS_KEY_FILE must be set together")
		}
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			return nil, fmt.Errorf("load TLS keypair: %w", err)
		}
		return &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS13,
		}, nil
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	defaultCertPath := filepath.Join(dataDir, "hub_tls_cert.pem")
	defaultKeyPath := filepath.Join(dataDir, "hub_tls_key.pem")

	if cert, err := tls.LoadX509KeyPair(defaultCertPath, defaultKeyPath); err == nil {
		_ = os.Chmod(defaultKeyPath, 0o600)
		if leaf, parseErr := x509.ParseCertificate(cert.Certificate[0]); parseErr == nil {
			if time.Now().Add(24 * time.Hour).Before(leaf.NotAfter) {
				return &tls.Config{
					Certificates: []tls.Certificate{cert},
					MinVersion:   tls.VersionTLS13,
				}, nil
			}
		}
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	var serialBytes [16]byte
	if _, err := rand.Read(serialBytes[:]); err != nil {
		return nil, err
	}
	serialBytes[0] &= 0x7f
	serial := new(big.Int).SetBytes(serialBytes[:])
	if serial.Sign() == 0 {
		serial = big.NewInt(1)
	}

	dnsNames := []string{"localhost"}
	ipAddrs := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	if u, parseErr := url.Parse(publicURL); parseErr == nil && u.Hostname() != "" {
		host := u.Hostname()
		if ip := net.ParseIP(host); ip != nil {
			already := false
			for _, existing := range ipAddrs {
				if existing.Equal(ip) {
					already = true
					break
				}
			}
			if !already {
				ipAddrs = append(ipAddrs, ip)
			}
		} else if !strings.EqualFold(host, "localhost") {
			dnsNames = append(dnsNames, host)
		}
	}

	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "quetzalcoatl-hub"},
		DNSNames:     dnsNames,
		IPAddresses:  ipAddrs,
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := writeFileAtomic(dataDir, ".hub_tls_cert.*.tmp", defaultCertPath, 0o644, certPEM); err != nil {
		return nil, err
	}
	if err := writeFileAtomic(dataDir, ".hub_tls_key.*.tmp", defaultKeyPath, 0o600, keyPEM); err != nil {
		return nil, err
	}

	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
	}, nil
}

func resolveQADBindAddr() (string, bool) {
	raw, exists := os.LookupEnv("QUETZALCOATL_HUB_QAD_ADDR")
	if !exists {
		return ":7842", true
	}
	trimmed := strings.TrimSpace(raw)
	switch strings.ToLower(trimmed) {
	case "", "0", "off", "false", "disabled", "none":
		return "", false
	default:
		return trimmed, true
	}
}

func errOrNil(err error) error {
	return err
}

func loadPublicKeyEnv(jsonEnv, fileEnv string) (map[string]any, error) {
	if raw := strings.TrimSpace(os.Getenv(jsonEnv)); raw != "" {
		return auth.ParsePublicKeySetJSON(raw)
	}
	if p := strings.TrimSpace(os.Getenv(fileEnv)); p != "" {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("read %s (%s): %w", fileEnv, p, err)
		}
		return auth.ParsePublicKeySetJSON(string(b))
	}
	return nil, nil
}

func defaultHubDataDir() string {
	if home := strings.TrimSpace(os.Getenv("QUETZALCOATL_HOME")); home != "" {
		return filepath.Join(home, "hub")
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "/tmp/quetzalcoatl-hub"
	}
	return filepath.Join(userHome, ".quetzalcoatl", "hub")
}

func main() {
	addr := envOrDefault("QUETZALCOATL_HUB_ADDR", "127.0.0.1:8443")
	certFile := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_TLS_CERT_FILE"))
	keyFile := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_TLS_KEY_FILE"))
	tlsFlag := strings.ToLower(strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_TLS")))
	enableHTTPS := tlsFlag == "1" || tlsFlag == "true" || (certFile != "" && keyFile != "")

	defaultScheme := "http://"
	if enableHTTPS {
		defaultScheme = "https://"
	}
	publicURL := envOrDefault("QUETZALCOATL_HUB_PUBLIC_URL", defaultScheme+addr)
	dataDir := envOrDefault("QUETZALCOATL_HUB_DATA_DIR", defaultHubDataDir())
	pgDSN := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_POSTGRES_DSN"))

	hmacSecret, oprfSeed, opaqueScalar, err := loadOrPersistHubSecrets(dataDir)
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize server secrets: %v", err)
	}

	tlsCfg, err := loadOrPersistTLSConfig(dataDir, publicURL, certFile, keyFile)
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize TLS certificate: %v", err)
	}

	oidcPubKeys, err := loadPublicKeyEnv("QUETZALCOATL_HUB_OIDC_PUBKEYS_JSON", "QUETZALCOATL_HUB_OIDC_PUBKEYS_FILE")
	if err != nil {
		log.Fatalf("quetzalcoatl-hub invalid OIDC public keys: %v", err)
	}
	webhookPubKeys, err := loadPublicKeyEnv("QUETZALCOATL_HUB_WEBHOOK_PUBKEYS_JSON", "QUETZALCOATL_HUB_WEBHOOK_PUBKEYS_FILE")
	if err != nil {
		log.Fatalf("quetzalcoatl-hub invalid webhook public keys: %v", err)
	}

	var st store.Store
	if pgDSN != "" {
		st, err = store.NewPostgresStore(pgDSN)
	} else {
		sqlitePath := envOrDefault("QUETZALCOATL_HUB_SQLITE_PATH", filepath.Join(dataDir, "hub.sqlite"))
		st, err = store.NewSQLiteStore(sqlitePath)
	}
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize store: %v", err)
	}
	defer func() { _ = st.Close() }()

	var blobs store.BlobStore
	s3Endpoint := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_S3_ENDPOINT"))
	if s3Endpoint != "" {
		blobs, err = store.NewS3BlobStore(store.SigV4Config{
			Endpoint:        s3Endpoint,
			Region:          envOrDefault("QUETZALCOATL_HUB_S3_REGION", "auto"),
			Bucket:          os.Getenv("QUETZALCOATL_HUB_S3_BUCKET"),
			AccessKeyID:     os.Getenv("QUETZALCOATL_HUB_S3_ACCESS_KEY_ID"),
			SecretAccessKey: os.Getenv("QUETZALCOATL_HUB_S3_SECRET_ACCESS_KEY"),
			UsePathStyle:    os.Getenv("QUETZALCOATL_HUB_S3_PATH_STYLE") == "1",
		}, nil, time.Now)
	} else {
		blobDir := envOrDefault("QUETZALCOATL_HUB_BLOB_DIR", filepath.Join(dataDir, "blobs"))
		blobs, err = store.NewLocalBlobStore(blobDir, publicURL, hmacSecret, st, time.Now)
	}
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize blob store: %v", err)
	}

	quotaBytes := envInt64OrDefault("QUETZALCOATL_HUB_AGENT_QUOTA_BYTES", 1024*1024*1024)
	if quotaBytes <= 0 {
		quotaBytes = 1024 * 1024 * 1024
	}

	rpID := envOrDefault("QUETZALCOATL_HUB_RP_ID", "localhost")
	origins := strings.Split(envOrDefault("QUETZALCOATL_HUB_ALLOWED_ORIGINS", publicURL), ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}

	authSvc, err := auth.NewService(st, blobs, auth.Config{
		RPID:                      rpID,
		PublicURL:                 publicURL,
		AllowedOrigins:            origins,
		ServerIdentity:            envOrDefault("QUETZALCOATL_HUB_SERVER_IDENTITY", "server:quetzalcoatl-hub:v2"),
		OPRFMasterSeed:            oprfSeed,
		ServerOpaquePrivateScalar: opaqueScalar,
		PairingHMACSecret:         hmacSecret,
		DefaultAgentQuotaBytes:    quotaBytes,
		OIDCIssuer:                os.Getenv("QUETZALCOATL_HUB_OIDC_ISSUER"),
		OIDCClientID:              os.Getenv("QUETZALCOATL_HUB_OIDC_CLIENT_ID"),
		OIDCPublicKeys:            oidcPubKeys,
		WebhookPublicKeys:         webhookPubKeys,
	}, time.Now)
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize auth service: %v", err)
	}

	spineSvc, err := spine.NewService(st, blobs, authSvc, spine.DefaultMaxPackBytes, time.Now)
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize spine service: %v", err)
	}

	leaseSvc, err := lease.NewService(st, authSvc, 30_000, 120_000, time.Now)
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize lease service: %v", err)
	}

	relaySvc := relay.NewServer(relay.Config{})
	defer func() { _ = relaySvc.Close() }()

	llmTracker := llmproxy.NewQuotaTracker(llmproxy.QuotaLimits{
		AccountDailyTokens: envInt64OrDefault("QUETZALCOATL_HUB_LLM_ACCOUNT_DAILY_TOKENS", 1_000_000),
		AccountTotalTokens: envInt64OrDefault("QUETZALCOATL_HUB_LLM_ACCOUNT_TOTAL_TOKENS", 0),
		AgentDailyTokens:   envInt64OrDefault("QUETZALCOATL_HUB_LLM_AGENT_DAILY_TOKENS", 500_000),
		AgentTotalTokens:   envInt64OrDefault("QUETZALCOATL_HUB_LLM_AGENT_TOTAL_TOKENS", 0),
	}, time.Now)
	llmWriteTimeoutMs := envInt64OrDefault("QUETZALCOATL_HUB_LLM_WRITE_TIMEOUT_MS", 15_000)
	llmSvc, err := llmproxy.NewService(authSvc, llmTracker, llmproxy.Config{
		UpstreamBaseURL:   os.Getenv("QUETZALCOATL_HUB_LLM_UPSTREAM_URL"),
		UpstreamAPIKey:    os.Getenv("QUETZALCOATL_HUB_LLM_API_KEY"),
		ChunkWriteTimeout: time.Duration(llmWriteTimeoutMs) * time.Millisecond,
	})
	if err != nil {
		log.Fatalf("quetzalcoatl-hub failed to initialize llm proxy: %v", err)
	}

	var qadSrv *relay.QADServer
	if qadAddr, enableQAD := resolveQADBindAddr(); enableQAD {
		qadSrv, err = relay.StartQADServer(qadAddr, tlsCfg)
		if err != nil {
			log.Fatalf("quetzalcoatl-hub failed to start QAD UDP listener on %s: %v", qadAddr, err)
		}
		log.Printf("quetzalcoatl-hub QAD listening on %s/udp", qadSrv.Addr().String())
		defer func() { _ = qadSrv.Close() }()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": "quetzalcoatl-hub",
			"status":  "ok",
		})
	})
	blobs.RegisterRoutes(mux)
	authSvc.RegisterRoutes(mux)
	spineSvc.RegisterRoutes(mux)
	leaseSvc.RegisterRoutes(mux)
	relaySvc.RegisterRoutes(mux)
	llmSvc.RegisterRoutes(mux)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if enableHTTPS {
		httpsTLS := tlsCfg.Clone()
		httpsTLS.NextProtos = []string{"http/1.1"}
		srv.TLSConfig = httpsTLS
		srv.TLSNextProto = make(map[string]func(*http.Server, *tls.Conn, http.Handler))
	}

	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("quetzalcoatl-hub listening on %s (tls=%v)", addr, enableHTTPS)
		var serveErr error
		if enableHTTPS {
			serveErr = srv.ListenAndServeTLS("", "")
		} else {
			serveErr = srv.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
		close(errCh)
	}()

	select {
	case <-sigCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if qadSrv != nil {
			_ = qadSrv.Close()
		}
		_ = relaySvc.Close()
		_ = srv.Shutdown(shutdownCtx)
	case serveErr := <-errCh:
		if serveErr != nil {
			log.Fatalf("quetzalcoatl-hub server error: %v", serveErr)
		}
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"quetzalcoatl-hub/internal/auth"
	"quetzalcoatl-hub/internal/lease"
	"quetzalcoatl-hub/internal/spine"
	"quetzalcoatl-hub/internal/store"
)

func envOrDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func decodeHexOrRandom32(envKey string) ([32]byte, error) {
	var out [32]byte
	if raw := strings.TrimSpace(os.Getenv(envKey)); raw != "" {
		b, err := hex.DecodeString(raw)
		if err != nil || len(b) != 32 {
			return out, errors.New(envKey + " must be 64 hex chars (32 bytes)")
		}
		copy(out[:], b)
		return out, nil
	}
	_, err := rand.Read(out[:])
	return out, err
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
	publicURL := envOrDefault("QUETZALCOATL_HUB_PUBLIC_URL", "http://"+addr)
	dataDir := envOrDefault("QUETZALCOATL_HUB_DATA_DIR", defaultHubDataDir())
	pgDSN := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_POSTGRES_DSN"))

	var st store.Store
	var err error
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

	hmacSecret, err := decodeHexOrRandom32("QUETZALCOATL_HUB_HMAC_SECRET_HEX")
	if err != nil {
		log.Fatalf("quetzalcoatl-hub invalid HMAC secret: %v", err)
	}
	oprfSeed, err := decodeHexOrRandom32("QUETZALCOATL_HUB_OPRF_SEED_HEX")
	if err != nil {
		log.Fatalf("quetzalcoatl-hub invalid OPRF seed: %v", err)
	}

	var opaqueScalar [32]byte
	if rawScalar := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_OPAQUE_PRIVATE_SCALAR_HEX")); rawScalar != "" {
		b, decErr := hex.DecodeString(rawScalar)
		if decErr != nil || len(b) != 32 {
			log.Fatalf("QUETZALCOATL_HUB_OPAQUE_PRIVATE_SCALAR_HEX must be 64 hex chars")
		}
		copy(opaqueScalar[:], b)
	}

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

	quotaBytes := int64(1024 * 1024 * 1024)
	if rawQuota := strings.TrimSpace(os.Getenv("QUETZALCOATL_HUB_AGENT_QUOTA_BYTES")); rawQuota != "" {
		if parsed, pErr := strconv.ParseInt(rawQuota, 10, 64); pErr == nil && parsed > 0 {
			quotaBytes = parsed
		}
	}

	rpID := envOrDefault("QUETZALCOATL_HUB_RP_ID", "localhost")
	origins := strings.Split(envOrDefault("QUETZALCOATL_HUB_ALLOWED_ORIGINS", publicURL), ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}

	authSvc, err := auth.NewService(st, blobs, auth.Config{
		RPID:                      rpID,
		AllowedOrigins:            origins,
		ServerIdentity:            envOrDefault("QUETZALCOATL_HUB_SERVER_IDENTITY", "server:quetzalcoatl-hub:v2"),
		OPRFMasterSeed:            oprfSeed,
		ServerOpaquePrivateScalar: opaqueScalar,
		PairingHMACSecret:         hmacSecret,
		DefaultAgentQuotaBytes:    quotaBytes,
		OIDCIssuer:                os.Getenv("QUETZALCOATL_HUB_OIDC_ISSUER"),
		OIDCClientID:              os.Getenv("QUETZALCOATL_HUB_OIDC_CLIENT_ID"),
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

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	sigCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("quetzalcoatl-hub listening on %s", addr)
		if serveErr := srv.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
		close(errCh)
	}()

	select {
	case <-sigCtx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	case serveErr := <-errCh:
		if serveErr != nil {
			log.Fatalf("quetzalcoatl-hub server error: %v", serveErr)
		}
	}
}

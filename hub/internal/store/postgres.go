// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const postgresSchemaDDL = `
CREATE TABLE IF NOT EXISTS accounts (
	account_id TEXT PRIMARY KEY,
	oidc_issuer TEXT NOT NULL DEFAULT '',
	oidc_subject TEXT NOT NULL DEFAULT '',
	created_at_ms BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_oidc
	ON accounts(oidc_issuer, oidc_subject)
	WHERE oidc_issuer != '' AND oidc_subject != '';

CREATE TABLE IF NOT EXISTS agents (
	agent_id TEXT PRIMARY KEY,
	owner_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	root_verifying_key_hex TEXT NOT NULL,
	quota_bytes BIGINT NOT NULL,
	used_bytes BIGINT NOT NULL DEFAULT 0,
	created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	device_id TEXT NOT NULL,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	ed25519_pubkey_hex TEXT NOT NULL,
	xwing_pubkey_hex TEXT NOT NULL,
	revoked BOOLEAN NOT NULL DEFAULT FALSE,
	created_at_ms BIGINT NOT NULL,
	PRIMARY KEY (agent_id, device_id)
);

CREATE TABLE IF NOT EXISTS sessions (
	token_sha256_hex TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	expires_at_ms BIGINT NOT NULL,
	created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_slots (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	slot_type TEXT NOT NULL,
	aad_utf8 TEXT NOT NULL,
	nonce_hex TEXT NOT NULL,
	ciphertext_hex TEXT NOT NULL,
	hpke_enc_hex TEXT NOT NULL DEFAULT '',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	updated_at_ms BIGINT NOT NULL,
	PRIMARY KEY (agent_id, slot_type)
);

CREATE TABLE IF NOT EXISTS auth_challenges (
	challenge_id TEXT PRIMARY KEY,
	purpose TEXT NOT NULL,
	challenge_bytes_hex TEXT NOT NULL,
	account_id TEXT NOT NULL DEFAULT '',
	agent_id TEXT NOT NULL DEFAULT '',
	payload_json TEXT NOT NULL DEFAULT '{}',
	expires_at_ms BIGINT NOT NULL,
	consumed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
	credential_id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	alg INTEGER NOT NULL,
	public_key_hex TEXT NOT NULL,
	sign_count BIGINT NOT NULL DEFAULT 0,
	prf_salt_hex TEXT NOT NULL,
	created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS opaque_registrations (
	agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	credential_identifier TEXT NOT NULL,
	client_public_key_hex TEXT NOT NULL,
	masking_key_hex TEXT NOT NULL,
	envelope_hex TEXT NOT NULL,
	oprf_key_scalar_hex TEXT NOT NULL,
	updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS opaque_login_states (
	login_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	device_id TEXT NOT NULL,
	km3_hex TEXT NOT NULL,
	preamble_hex TEXT NOT NULL,
	server_mac_hex TEXT NOT NULL,
	expires_at_ms BIGINT NOT NULL,
	consumed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
	pairing_id TEXT PRIMARY KEY,
	short_code_hmac_hex TEXT NOT NULL,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	initiator_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	new_device_id TEXT NOT NULL DEFAULT '',
	new_device_ed25519_hex TEXT NOT NULL DEFAULT '',
	new_device_xwing_pk_hex TEXT NOT NULL DEFAULT '',
	hpke_enc_hex TEXT NOT NULL DEFAULT '',
	ciphertext_hex TEXT NOT NULL DEFAULT '',
	aad_utf8 TEXT NOT NULL DEFAULT '',
	failed_attempts INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 5,
	locked BOOLEAN NOT NULL DEFAULT FALSE,
	consumed BOOLEAN NOT NULL DEFAULT FALSE,
	expires_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardian_configs (
	agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
	threshold INTEGER NOT NULL,
	total INTEGER NOT NULL,
	commitment_blake3_hex TEXT NOT NULL,
	updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardian_shares (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	share_index INTEGER NOT NULL,
	guardian_id TEXT NOT NULL,
	guardian_pubkey_hex TEXT NOT NULL,
	encrypted_share_hex TEXT NOT NULL,
	hpke_enc_hex TEXT NOT NULL DEFAULT '',
	aad_utf8 TEXT NOT NULL,
	PRIMARY KEY (agent_id, share_index)
);

CREATE TABLE IF NOT EXISTS guardian_recoveries (
	recovery_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	requester_xwing_pk_hex TEXT NOT NULL,
	expires_at_ms BIGINT NOT NULL,
	created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardian_approvals (
	recovery_id TEXT NOT NULL REFERENCES guardian_recoveries(recovery_id) ON DELETE CASCADE,
	share_index INTEGER NOT NULL,
	guardian_id TEXT NOT NULL,
	signature_hex TEXT NOT NULL,
	rewrapped_share_hex TEXT NOT NULL DEFAULT '',
	rewrapped_hpke_enc_hex TEXT NOT NULL DEFAULT '',
	approved_at_ms BIGINT NOT NULL,
	PRIMARY KEY (recovery_id, share_index)
);

CREATE TABLE IF NOT EXISTS pack_uploads (
	upload_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	pack_id TEXT NOT NULL,
	content_length BIGINT NOT NULL,
	sha256_hex TEXT NOT NULL,
	blob_key TEXT NOT NULL,
	uploaded BOOLEAN NOT NULL DEFAULT FALSE,
	committed BOOLEAN NOT NULL DEFAULT FALSE,
	expires_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS spine_packs (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	server_seq BIGINT NOT NULL,
	pack_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	compartment TEXT NOT NULL,
	epoch BIGINT NOT NULL,
	first_seq BIGINT NOT NULL,
	last_seq BIGINT NOT NULL,
	min_hlc_hex TEXT NOT NULL,
	max_hlc_hex TEXT NOT NULL,
	padded_len INTEGER NOT NULL,
	uncompressed_blake3_hex TEXT NOT NULL,
	aad_utf8 TEXT NOT NULL,
	dek_wrap_nonce_hex TEXT NOT NULL,
	wrapped_dek_hex TEXT NOT NULL,
	pack_nonce_hex TEXT NOT NULL,
	content_length BIGINT NOT NULL,
	sha256_hex TEXT NOT NULL,
	blob_key TEXT NOT NULL,
	created_at_ms BIGINT NOT NULL,
	PRIMARY KEY (agent_id, server_seq),
	UNIQUE (agent_id, pack_id)
);

CREATE TABLE IF NOT EXISTS leases (
	agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
	holder_device_id TEXT NOT NULL DEFAULT '',
	witness_epoch BIGINT NOT NULL,
	expires_at_ms BIGINT NOT NULL,
	updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_rooms (
	group_id TEXT PRIMARY KEY,
	owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	secrecy_level BIGINT NOT NULL,
	current_mls_epoch BIGINT NOT NULL DEFAULT 0,
	created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
	group_id TEXT NOT NULL REFERENCES group_rooms(group_id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	added_at_ms BIGINT NOT NULL,
	PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE IF NOT EXISTS group_commits (
	group_id TEXT NOT NULL REFERENCES group_rooms(group_id) ON DELETE CASCADE,
	server_seq BIGINT NOT NULL,
	mls_epoch BIGINT NOT NULL,
	causal_parent_seq BIGINT NOT NULL,
	sender_agent_id TEXT NOT NULL,
	sender_device_id TEXT NOT NULL,
	mentions_json TEXT NOT NULL,
	ciphertext_b64 TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'message',
	author_kind TEXT NOT NULL DEFAULT 'human',
	hop BIGINT NOT NULL DEFAULT 0,
	created_at_ms BIGINT NOT NULL,
	PRIMARY KEY (group_id, server_seq)
);

CREATE TABLE IF NOT EXISTS webhook_ingress_queue (
	ingress_id BIGSERIAL PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	event_id_hash TEXT NOT NULL,
	target_device_id TEXT NOT NULL DEFAULT '',
	hpke_enc_hex TEXT NOT NULL,
	ciphertext_hex TEXT NOT NULL,
	aad_utf8 TEXT NOT NULL,
	received_at_ms BIGINT NOT NULL,
	created_at_ms BIGINT NOT NULL,
	UNIQUE (agent_id, channel, event_id_hash, target_device_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_ingress_agent
	ON webhook_ingress_queue(agent_id, ingress_id);
`

type PostgresStore struct {
	db *sql.DB
}

var _ Store = (*PostgresStore)(nil)

func NewPostgresStore(dsn string) (*PostgresStore, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	if _, err := db.Exec(postgresSchemaDDL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init postgres schema: %w", err)
	}
	if err := migratePostgresGroupSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate postgres group schema: %w", err)
	}
	if err := migratePostgresWebhookSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate postgres webhook schema: %w", err)
	}
	return &PostgresStore{db: db}, nil
}

// migratePostgresWebhookSchema 补齐多设备入站列并切换唯一索引（幂等）。
func migratePostgresWebhookSchema(db *sql.DB) error {
	statements := []string{
		`ALTER TABLE webhook_ingress_queue ADD COLUMN IF NOT EXISTS target_device_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE webhook_ingress_queue DROP CONSTRAINT IF EXISTS webhook_ingress_queue_agent_id_channel_event_id_hash_key`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_ingress_unique ON webhook_ingress_queue(agent_id, channel, event_id_hash, target_device_id)`,
	}
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt, err)
		}
	}
	return nil
}

// migratePostgresGroupSchema 为 Fix Round 1 之前的旧库补齐群组新列（幂等）。
func migratePostgresGroupSchema(db *sql.DB) error {
	statements := []string{
		`ALTER TABLE group_rooms ADD COLUMN IF NOT EXISTS current_mls_epoch BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE group_commits ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message'`,
		`ALTER TABLE group_commits ADD COLUMN IF NOT EXISTS author_kind TEXT NOT NULL DEFAULT 'human'`,
		`ALTER TABLE group_commits ADD COLUMN IF NOT EXISTS hop BIGINT NOT NULL DEFAULT 0`,
	}
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt, err)
		}
	}
	return nil
}

func (p *PostgresStore) Close() error {
	return p.db.Close()
}

func (p *PostgresStore) CreateAccount(ctx context.Context, acc Account) error {
	_, err := p.db.ExecContext(ctx,
		`INSERT INTO accounts (account_id, oidc_issuer, oidc_subject, created_at_ms) VALUES ($1, $2, $3, $4)`,
		acc.AccountID, acc.OIDCIssuer, acc.OIDCSubject, acc.CreatedAtMs,
	)
	return err
}

func (p *PostgresStore) GetAccountByOIDC(ctx context.Context, issuer, subject string) (*Account, error) {
	var acc Account
	err := p.db.QueryRowContext(ctx,
		`SELECT account_id, oidc_issuer, oidc_subject, created_at_ms FROM accounts WHERE oidc_issuer = $1 AND oidc_subject = $2`,
		issuer, subject,
	).Scan(&acc.AccountID, &acc.OIDCIssuer, &acc.OIDCSubject, &acc.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &acc, nil
}

func (p *PostgresStore) DeleteAccountByOIDC(ctx context.Context, issuer, subject string) ([]string, error) {
	acc, err := p.GetAccountByOIDC(ctx, issuer, subject)
	if err != nil {
		return nil, err
	}
	return p.DeleteAccount(ctx, acc.AccountID)
}

func (p *PostgresStore) DeleteAccount(ctx context.Context, accountID string) ([]string, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT sp.blob_key
		FROM spine_packs sp
		JOIN agents ag ON ag.agent_id = sp.agent_id
		WHERE ag.owner_account_id = $1
		UNION
		SELECT DISTINCT pu.blob_key
		FROM pack_uploads pu
		JOIN agents ag ON ag.agent_id = pu.agent_id
		WHERE ag.owner_account_id = $1
	`, accountID)
	if err != nil {
		return nil, err
	}
	var blobKeys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if k != "" {
			blobKeys = append(blobKeys, k)
		}
	}
	_ = rows.Close()

	res, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE account_id = $1`, accountID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return blobKeys, nil
}

func (p *PostgresStore) CreateAgent(ctx context.Context, agent Agent) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO agents (agent_id, owner_account_id, root_verifying_key_hex, quota_bytes, used_bytes, created_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, agent.AgentID, agent.OwnerAccountID, agent.RootVerifyingKeyHex, agent.QuotaBytes, agent.UsedBytes, agent.CreatedAtMs)
	return err
}

func (p *PostgresStore) GetAgent(ctx context.Context, agentID string) (*Agent, error) {
	var ag Agent
	err := p.db.QueryRowContext(ctx, `
		SELECT agent_id, owner_account_id, root_verifying_key_hex, quota_bytes, used_bytes, created_at_ms
		FROM agents WHERE agent_id = $1
	`, agentID).Scan(&ag.AgentID, &ag.OwnerAccountID, &ag.RootVerifyingKeyHex, &ag.QuotaBytes, &ag.UsedBytes, &ag.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &ag, nil
}

func (p *PostgresStore) SetAgentQuota(ctx context.Context, agentID string, quotaBytes int64) error {
	res, err := p.db.ExecContext(ctx, `UPDATE agents SET quota_bytes = $1 WHERE agent_id = $2`, quotaBytes, agentID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) UpsertDevice(ctx context.Context, dev Device) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO devices (agent_id, device_id, account_id, ed25519_pubkey_hex, xwing_pubkey_hex, revoked, created_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (agent_id, device_id) DO UPDATE SET
			ed25519_pubkey_hex = EXCLUDED.ed25519_pubkey_hex,
			xwing_pubkey_hex = EXCLUDED.xwing_pubkey_hex,
			revoked = EXCLUDED.revoked
	`, dev.AgentID, dev.DeviceID, dev.AccountID, dev.Ed25519PubKeyHex, dev.XWingPubKeyHex, dev.Revoked, dev.CreatedAtMs)
	return err
}

func (p *PostgresStore) GetDevice(ctx context.Context, agentID, deviceID string) (*Device, error) {
	var dev Device
	err := p.db.QueryRowContext(ctx, `
		SELECT agent_id, device_id, account_id, ed25519_pubkey_hex, xwing_pubkey_hex, revoked, created_at_ms
		FROM devices WHERE agent_id = $1 AND device_id = $2
	`, agentID, deviceID).Scan(&dev.AgentID, &dev.DeviceID, &dev.AccountID, &dev.Ed25519PubKeyHex, &dev.XWingPubKeyHex, &dev.Revoked, &dev.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &dev, nil
}

func (p *PostgresStore) ListDevices(ctx context.Context, agentID string) ([]Device, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT agent_id, device_id, account_id, ed25519_pubkey_hex, xwing_pubkey_hex, revoked, created_at_ms
		FROM devices WHERE agent_id = $1 ORDER BY created_at_ms ASC, device_id ASC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Device
	for rows.Next() {
		var dev Device
		if err := rows.Scan(&dev.AgentID, &dev.DeviceID, &dev.AccountID, &dev.Ed25519PubKeyHex, &dev.XWingPubKeyHex, &dev.Revoked, &dev.CreatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, dev)
	}
	return out, rows.Err()
}

func (p *PostgresStore) CreateSession(ctx context.Context, sess Session) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO sessions (token_sha256_hex, account_id, agent_id, device_id, expires_at_ms, created_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, sess.TokenSHA256Hex, sess.AccountID, sess.AgentID, sess.DeviceID, sess.ExpiresAtMs, sess.CreatedAtMs)
	return err
}

func (p *PostgresStore) GetSession(ctx context.Context, tokenSHA256Hex string) (*Session, error) {
	var sess Session
	err := p.db.QueryRowContext(ctx, `
		SELECT token_sha256_hex, account_id, agent_id, device_id, expires_at_ms, created_at_ms
		FROM sessions WHERE token_sha256_hex = $1
	`, tokenSHA256Hex).Scan(&sess.TokenSHA256Hex, &sess.AccountID, &sess.AgentID, &sess.DeviceID, &sess.ExpiresAtMs, &sess.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (p *PostgresStore) UpsertKeySlot(ctx context.Context, slot KeySlotEnvelope) error {
	if slot.MetadataJSON == "" {
		slot.MetadataJSON = "{}"
	}
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO key_slots (agent_id, slot_type, aad_utf8, nonce_hex, ciphertext_hex, hpke_enc_hex, metadata_json, updated_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (agent_id, slot_type) DO UPDATE SET
			aad_utf8 = EXCLUDED.aad_utf8,
			nonce_hex = EXCLUDED.nonce_hex,
			ciphertext_hex = EXCLUDED.ciphertext_hex,
			hpke_enc_hex = EXCLUDED.hpke_enc_hex,
			metadata_json = EXCLUDED.metadata_json,
			updated_at_ms = EXCLUDED.updated_at_ms
	`, slot.AgentID, slot.Slot, slot.AADUTF8, slot.NonceHex, slot.CiphertextHex, slot.HPKEEncHex, slot.MetadataJSON, slot.UpdatedAtMs)
	return err
}

func (p *PostgresStore) GetKeySlot(ctx context.Context, agentID, slotType string) (*KeySlotEnvelope, error) {
	var slot KeySlotEnvelope
	err := p.db.QueryRowContext(ctx, `
		SELECT agent_id, slot_type, aad_utf8, nonce_hex, ciphertext_hex, hpke_enc_hex, metadata_json, updated_at_ms
		FROM key_slots WHERE agent_id = $1 AND slot_type = $2
	`, agentID, slotType).Scan(&slot.AgentID, &slot.Slot, &slot.AADUTF8, &slot.NonceHex, &slot.CiphertextHex, &slot.HPKEEncHex, &slot.MetadataJSON, &slot.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &slot, nil
}

func (p *PostgresStore) ListKeySlots(ctx context.Context, agentID string) ([]KeySlotEnvelope, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT agent_id, slot_type, aad_utf8, nonce_hex, ciphertext_hex, hpke_enc_hex, metadata_json, updated_at_ms
		FROM key_slots WHERE agent_id = $1 ORDER BY slot_type ASC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeySlotEnvelope
	for rows.Next() {
		var slot KeySlotEnvelope
		if err := rows.Scan(&slot.AgentID, &slot.Slot, &slot.AADUTF8, &slot.NonceHex, &slot.CiphertextHex, &slot.HPKEEncHex, &slot.MetadataJSON, &slot.UpdatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, slot)
	}
	return out, rows.Err()
}

func (p *PostgresStore) SaveChallenge(ctx context.Context, ch AuthChallenge) error {
	if ch.PayloadJSON == "" {
		ch.PayloadJSON = "{}"
	}
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO auth_challenges (challenge_id, purpose, challenge_bytes_hex, account_id, agent_id, payload_json, expires_at_ms, consumed)
		VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
	`, ch.ChallengeID, ch.Purpose, ch.ChallengeBytesHex, ch.AccountID, ch.AgentID, ch.PayloadJSON, ch.ExpiresAtMs)
	return err
}

func (p *PostgresStore) ConsumeChallenge(ctx context.Context, challengeID, purpose string, nowMs int64) (*AuthChallenge, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var ch AuthChallenge
	err = tx.QueryRowContext(ctx, `
		SELECT challenge_id, purpose, challenge_bytes_hex, account_id, agent_id, payload_json, expires_at_ms, consumed
		FROM auth_challenges WHERE challenge_id = $1 AND purpose = $2 FOR UPDATE
	`, challengeID, purpose).Scan(&ch.ChallengeID, &ch.Purpose, &ch.ChallengeBytesHex, &ch.AccountID, &ch.AgentID, &ch.PayloadJSON, &ch.ExpiresAtMs, &ch.Consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if ch.Consumed {
		return nil, ErrConflict
	}
	if ch.ExpiresAtMs <= nowMs {
		return nil, ErrExpired
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_challenges SET consumed = TRUE WHERE challenge_id = $1`, challengeID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	ch.Consumed = true
	return &ch, nil
}

func (p *PostgresStore) SavePasskeyCredential(ctx context.Context, cred PasskeyCredential) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO passkey_credentials (credential_id, account_id, agent_id, alg, public_key_hex, sign_count, prf_salt_hex, created_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, cred.CredentialID, cred.AccountID, cred.AgentID, cred.Alg, cred.PublicKeyHex, cred.SignCount, cred.PRFSaltHex, cred.CreatedAtMs)
	return err
}

func (p *PostgresStore) GetPasskeyCredential(ctx context.Context, credentialID string) (*PasskeyCredential, error) {
	var c PasskeyCredential
	err := p.db.QueryRowContext(ctx, `
		SELECT credential_id, account_id, agent_id, alg, public_key_hex, sign_count, prf_salt_hex, created_at_ms
		FROM passkey_credentials WHERE credential_id = $1
	`, credentialID).Scan(&c.CredentialID, &c.AccountID, &c.AgentID, &c.Alg, &c.PublicKeyHex, &c.SignCount, &c.PRFSaltHex, &c.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (p *PostgresStore) ListPasskeyCredentialsByAgent(ctx context.Context, agentID string) ([]PasskeyCredential, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT credential_id, account_id, agent_id, alg, public_key_hex, sign_count, prf_salt_hex, created_at_ms
		FROM passkey_credentials WHERE agent_id = $1 ORDER BY created_at_ms ASC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PasskeyCredential
	for rows.Next() {
		var c PasskeyCredential
		if err := rows.Scan(&c.CredentialID, &c.AccountID, &c.AgentID, &c.Alg, &c.PublicKeyHex, &c.SignCount, &c.PRFSaltHex, &c.CreatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *PostgresStore) UpdatePasskeySignCount(ctx context.Context, credentialID string, signCount uint32) error {
	_, err := p.db.ExecContext(ctx, `UPDATE passkey_credentials SET sign_count = $1 WHERE credential_id = $2`, signCount, credentialID)
	return err
}

func (p *PostgresStore) UpsertOpaqueRegistration(ctx context.Context, reg OpaqueRegistration) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO opaque_registrations (agent_id, account_id, credential_identifier, client_public_key_hex, masking_key_hex, envelope_hex, oprf_key_scalar_hex, updated_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (agent_id) DO UPDATE SET
			credential_identifier = EXCLUDED.credential_identifier,
			client_public_key_hex = EXCLUDED.client_public_key_hex,
			masking_key_hex = EXCLUDED.masking_key_hex,
			envelope_hex = EXCLUDED.envelope_hex,
			oprf_key_scalar_hex = EXCLUDED.oprf_key_scalar_hex,
			updated_at_ms = EXCLUDED.updated_at_ms
	`, reg.AgentID, reg.AccountID, reg.CredentialIdentifier, reg.ClientPublicKeyHex, reg.MaskingKeyHex, reg.EnvelopeHex, reg.OPRFKeyScalarHex, reg.UpdatedAtMs)
	return err
}

func (p *PostgresStore) GetOpaqueRegistration(ctx context.Context, agentID string) (*OpaqueRegistration, error) {
	var reg OpaqueRegistration
	err := p.db.QueryRowContext(ctx, `
		SELECT agent_id, account_id, credential_identifier, client_public_key_hex, masking_key_hex, envelope_hex, oprf_key_scalar_hex, updated_at_ms
		FROM opaque_registrations WHERE agent_id = $1
	`, agentID).Scan(&reg.AgentID, &reg.AccountID, &reg.CredentialIdentifier, &reg.ClientPublicKeyHex, &reg.MaskingKeyHex, &reg.EnvelopeHex, &reg.OPRFKeyScalarHex, &reg.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &reg, nil
}

func (p *PostgresStore) SaveOpaqueLoginState(ctx context.Context, st OpaqueLoginState) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO opaque_login_states (login_id, agent_id, account_id, device_id, km3_hex, preamble_hex, server_mac_hex, expires_at_ms, consumed)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
	`, st.LoginID, st.AgentID, st.AccountID, st.DeviceID, st.KM3Hex, st.PreambleHex, st.ServerMACHex, st.ExpiresAtMs)
	return err
}

func (p *PostgresStore) ConsumeOpaqueLoginState(ctx context.Context, loginID string, nowMs int64) (*OpaqueLoginState, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var st OpaqueLoginState
	err = tx.QueryRowContext(ctx, `
		SELECT login_id, agent_id, account_id, device_id, km3_hex, preamble_hex, server_mac_hex, expires_at_ms, consumed
		FROM opaque_login_states WHERE login_id = $1 FOR UPDATE
	`, loginID).Scan(&st.LoginID, &st.AgentID, &st.AccountID, &st.DeviceID, &st.KM3Hex, &st.PreambleHex, &st.ServerMACHex, &st.ExpiresAtMs, &st.Consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if st.Consumed {
		return nil, ErrConflict
	}
	if st.ExpiresAtMs <= nowMs {
		return nil, ErrExpired
	}
	if _, err := tx.ExecContext(ctx, `UPDATE opaque_login_states SET consumed = TRUE WHERE login_id = $1`, loginID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	st.Consumed = true
	return &st, nil
}

func (p *PostgresStore) CreatePairingSession(ctx context.Context, ps PairingSession) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO pairing_sessions (pairing_id, short_code_hmac_hex, agent_id, initiator_account_id, max_attempts, expires_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, ps.PairingID, ps.ShortCodeHMACHex, ps.AgentID, ps.InitiatorAccountID, ps.MaxAttempts, ps.ExpiresAtMs)
	return err
}

func scanPGPairingSession(row interface{ Scan(...any) error }) (*PairingSession, error) {
	var ps PairingSession
	err := row.Scan(
		&ps.PairingID, &ps.ShortCodeHMACHex, &ps.AgentID, &ps.InitiatorAccountID,
		&ps.NewDeviceID, &ps.NewDeviceEd25519Hex, &ps.NewDeviceXWingPKHex,
		&ps.HPKEEncHex, &ps.CiphertextHex, &ps.AADUTF8,
		&ps.FailedAttempts, &ps.MaxAttempts, &ps.Locked, &ps.Consumed, &ps.ExpiresAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &ps, nil
}

func (p *PostgresStore) GetPairingSession(ctx context.Context, pairingID string) (*PairingSession, error) {
	row := p.db.QueryRowContext(ctx, `
		SELECT pairing_id, short_code_hmac_hex, agent_id, initiator_account_id,
		       new_device_id, new_device_ed25519_hex, new_device_xwing_pk_hex,
		       hpke_enc_hex, ciphertext_hex, aad_utf8,
		       failed_attempts, max_attempts, locked, consumed, expires_at_ms
		FROM pairing_sessions WHERE pairing_id = $1
	`, pairingID)
	return scanPGPairingSession(row)
}

func (p *PostgresStore) RecordPairingAttempt(ctx context.Context, pairingID, expectedShortCodeHMACHex, providedHMACHex string, nowMs int64) (*PairingSession, bool, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
		SELECT pairing_id, short_code_hmac_hex, agent_id, initiator_account_id,
		       new_device_id, new_device_ed25519_hex, new_device_xwing_pk_hex,
		       hpke_enc_hex, ciphertext_hex, aad_utf8,
		       failed_attempts, max_attempts, locked, consumed, expires_at_ms
		FROM pairing_sessions WHERE pairing_id = $1 FOR UPDATE
	`, pairingID)
	ps, err := scanPGPairingSession(row)
	if err != nil {
		return nil, false, err
	}
	if ps.Consumed {
		return ps, false, ErrConflict
	}
	if ps.ExpiresAtMs <= nowMs {
		return ps, false, ErrExpired
	}
	if ps.Locked || ps.FailedAttempts >= ps.MaxAttempts {
		return ps, false, ErrLocked
	}
	_ = expectedShortCodeHMACHex
	matched := len(ps.ShortCodeHMACHex) == len(providedHMACHex) &&
		subtle.ConstantTimeCompare([]byte(ps.ShortCodeHMACHex), []byte(providedHMACHex)) == 1
	if !matched {
		ps.FailedAttempts++
		if ps.FailedAttempts >= ps.MaxAttempts {
			ps.Locked = true
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE pairing_sessions SET failed_attempts = $1, locked = $2 WHERE pairing_id = $3
		`, ps.FailedAttempts, ps.Locked, pairingID); err != nil {
			return nil, false, err
		}
		if err := tx.Commit(); err != nil {
			return nil, false, err
		}
		return ps, false, nil
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return ps, true, nil
}

func (p *PostgresStore) UpdatePairingJoiner(ctx context.Context, pairingID, newDevID, newEdHex, newXWingHex string) error {
	res, err := p.db.ExecContext(ctx, `
		UPDATE pairing_sessions
		SET new_device_id = $1, new_device_ed25519_hex = $2, new_device_xwing_pk_hex = $3
		WHERE pairing_id = $4 AND locked = FALSE AND consumed = FALSE AND new_device_id = '' AND ciphertext_hex = ''
	`, newDevID, newEdHex, newXWingHex, pairingID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return nil
}

func (p *PostgresStore) ApprovePairingSession(ctx context.Context, pairingID, hpkeEncHex, ciphertextHex, aadUTF8 string) error {
	res, err := p.db.ExecContext(ctx, `
		UPDATE pairing_sessions
		SET hpke_enc_hex = $1, ciphertext_hex = $2, aad_utf8 = $3
		WHERE pairing_id = $4 AND locked = FALSE AND consumed = FALSE AND new_device_id != '' AND ciphertext_hex = ''
	`, hpkeEncHex, ciphertextHex, aadUTF8, pairingID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return nil
}

func (p *PostgresStore) ConsumePairingSession(ctx context.Context, pairingID string, nowMs int64) (*PairingSession, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
		SELECT pairing_id, short_code_hmac_hex, agent_id, initiator_account_id,
		       new_device_id, new_device_ed25519_hex, new_device_xwing_pk_hex,
		       hpke_enc_hex, ciphertext_hex, aad_utf8,
		       failed_attempts, max_attempts, locked, consumed, expires_at_ms
		FROM pairing_sessions WHERE pairing_id = $1 FOR UPDATE
	`, pairingID)
	ps, err := scanPGPairingSession(row)
	if err != nil {
		return nil, err
	}
	if ps.Consumed {
		return nil, ErrConflict
	}
	if ps.Locked {
		return nil, ErrLocked
	}
	if ps.ExpiresAtMs <= nowMs {
		return nil, ErrExpired
	}
	if ps.CiphertextHex == "" || ps.HPKEEncHex == "" {
		return nil, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE pairing_sessions SET consumed = TRUE WHERE pairing_id = $1`, pairingID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	ps.Consumed = true
	return ps, nil
}

func (p *PostgresStore) SaveGuardianSetup(ctx context.Context, cfg GuardianConfig, shares []GuardianShareCustody) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO guardian_configs (agent_id, threshold, total, commitment_blake3_hex, updated_at_ms)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (agent_id) DO UPDATE SET
			threshold = EXCLUDED.threshold,
			total = EXCLUDED.total,
			commitment_blake3_hex = EXCLUDED.commitment_blake3_hex,
			updated_at_ms = EXCLUDED.updated_at_ms
	`, cfg.AgentID, cfg.Threshold, cfg.Total, cfg.CommitmentBlake3Hex, cfg.UpdatedAtMs); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM guardian_shares WHERE agent_id = $1`, cfg.AgentID); err != nil {
		return err
	}
	for _, sh := range shares {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO guardian_shares (agent_id, share_index, guardian_id, guardian_pubkey_hex, encrypted_share_hex, hpke_enc_hex, aad_utf8)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, cfg.AgentID, sh.ShareIndex, sh.GuardianID, sh.GuardianPubKeyHex, sh.EncryptedShareHex, sh.HPKEEncHex, sh.AADUTF8); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (p *PostgresStore) GetGuardianSetup(ctx context.Context, agentID string) (*GuardianConfig, []GuardianShareCustody, error) {
	var cfg GuardianConfig
	err := p.db.QueryRowContext(ctx, `
		SELECT agent_id, threshold, total, commitment_blake3_hex, updated_at_ms
		FROM guardian_configs WHERE agent_id = $1
	`, agentID).Scan(&cfg.AgentID, &cfg.Threshold, &cfg.Total, &cfg.CommitmentBlake3Hex, &cfg.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	rows, err := p.db.QueryContext(ctx, `
		SELECT agent_id, share_index, guardian_id, guardian_pubkey_hex, encrypted_share_hex, hpke_enc_hex, aad_utf8
		FROM guardian_shares WHERE agent_id = $1 ORDER BY share_index ASC
	`, agentID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var shares []GuardianShareCustody
	for rows.Next() {
		var sh GuardianShareCustody
		if err := rows.Scan(&sh.AgentID, &sh.ShareIndex, &sh.GuardianID, &sh.GuardianPubKeyHex, &sh.EncryptedShareHex, &sh.HPKEEncHex, &sh.AADUTF8); err != nil {
			return nil, nil, err
		}
		shares = append(shares, sh)
	}
	return &cfg, shares, rows.Err()
}

func (p *PostgresStore) CreateGuardianRecovery(ctx context.Context, rec GuardianRecovery) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO guardian_recoveries (recovery_id, agent_id, requester_xwing_pk_hex, expires_at_ms, created_at_ms)
		VALUES ($1, $2, $3, $4, $5)
	`, rec.RecoveryID, rec.AgentID, rec.RequesterXWingPKHex, rec.ExpiresAtMs, rec.CreatedAtMs)
	return err
}

func (p *PostgresStore) GetGuardianRecovery(ctx context.Context, recoveryID string) (*GuardianRecovery, error) {
	var rec GuardianRecovery
	err := p.db.QueryRowContext(ctx, `
		SELECT recovery_id, agent_id, requester_xwing_pk_hex, expires_at_ms, created_at_ms
		FROM guardian_recoveries WHERE recovery_id = $1
	`, recoveryID).Scan(&rec.RecoveryID, &rec.AgentID, &rec.RequesterXWingPKHex, &rec.ExpiresAtMs, &rec.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (p *PostgresStore) AddGuardianApproval(ctx context.Context, app GuardianApproval) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO guardian_approvals (recovery_id, share_index, guardian_id, signature_hex, rewrapped_share_hex, rewrapped_hpke_enc_hex, approved_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (recovery_id, share_index) DO UPDATE SET
			signature_hex = EXCLUDED.signature_hex,
			rewrapped_share_hex = EXCLUDED.rewrapped_share_hex,
			rewrapped_hpke_enc_hex = EXCLUDED.rewrapped_hpke_enc_hex,
			approved_at_ms = EXCLUDED.approved_at_ms
	`, app.RecoveryID, app.ShareIndex, app.GuardianID, app.SignatureHex, app.RewrappedShareHex, app.RewrappedHPKEEncHex, app.ApprovedAtMs)
	return err
}

func (p *PostgresStore) ListGuardianApprovals(ctx context.Context, recoveryID string) ([]GuardianApproval, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT recovery_id, share_index, guardian_id, signature_hex, rewrapped_share_hex, rewrapped_hpke_enc_hex, approved_at_ms
		FROM guardian_approvals WHERE recovery_id = $1 ORDER BY share_index ASC
	`, recoveryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GuardianApproval
	for rows.Next() {
		var a GuardianApproval
		if err := rows.Scan(&a.RecoveryID, &a.ShareIndex, &a.GuardianID, &a.SignatureHex, &a.RewrappedShareHex, &a.RewrappedHPKEEncHex, &a.ApprovedAtMs); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (p *PostgresStore) CreatePackUpload(ctx context.Context, up PackUpload) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO pack_uploads (upload_id, agent_id, pack_id, content_length, sha256_hex, blob_key, uploaded, committed, expires_at_ms)
		VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE, $7)
	`, up.UploadID, up.AgentID, up.PackID, up.ContentLength, up.SHA256Hex, up.BlobKey, up.ExpiresAtMs)
	return err
}

func (p *PostgresStore) GetPackUpload(ctx context.Context, uploadID string) (*PackUpload, error) {
	var up PackUpload
	err := p.db.QueryRowContext(ctx, `
		SELECT upload_id, agent_id, pack_id, content_length, sha256_hex, blob_key, uploaded, committed, expires_at_ms
		FROM pack_uploads WHERE upload_id = $1
	`, uploadID).Scan(&up.UploadID, &up.AgentID, &up.PackID, &up.ContentLength, &up.SHA256Hex, &up.BlobKey, &up.Uploaded, &up.Committed, &up.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &up, nil
}

func (p *PostgresStore) MarkPackUploaded(ctx context.Context, uploadID string) error {
	res, err := p.db.ExecContext(ctx, `UPDATE pack_uploads SET uploaded = TRUE WHERE upload_id = $1`, uploadID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) CommitSpinePack(ctx context.Context, uploadID string, rec SpinePackRecord) (*SpinePackRecord, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// Lock agent row to serialize per-agent server_seq & quota checks
	var quotaBytes, usedBytes int64
	if err := tx.QueryRowContext(ctx, `SELECT quota_bytes, used_bytes FROM agents WHERE agent_id = $1 FOR UPDATE`, rec.AgentID).Scan(&quotaBytes, &usedBytes); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	var existing SpinePackRecord
	err = tx.QueryRowContext(ctx, `
		SELECT agent_id, server_seq, pack_id, device_id, compartment, epoch, first_seq, last_seq,
		       min_hlc_hex, max_hlc_hex, padded_len, uncompressed_blake3_hex, aad_utf8,
		       dek_wrap_nonce_hex, wrapped_dek_hex, pack_nonce_hex, content_length, sha256_hex, blob_key, created_at_ms
		FROM spine_packs WHERE agent_id = $1 AND pack_id = $2
	`, rec.AgentID, rec.PackID).Scan(
		&existing.AgentID, &existing.ServerSeq, &existing.PackID, &existing.DeviceID, &existing.Compartment,
		&existing.Epoch, &existing.FirstSeq, &existing.LastSeq, &existing.MinHLCHex, &existing.MaxHLCHex,
		&existing.PaddedLen, &existing.UncompressedBlake3Hex, &existing.AADUTF8, &existing.DEKWrapNonceHex,
		&existing.WrappedDEKHex, &existing.PackNonceHex, &existing.ContentLength, &existing.SHA256Hex,
		&existing.BlobKey, &existing.CreatedAtMs,
	)
	if err == nil {
		if existing.AADUTF8 != rec.AADUTF8 || existing.SHA256Hex != rec.SHA256Hex || existing.ContentLength != rec.ContentLength {
			return nil, ErrConflict
		}
		return &existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var up PackUpload
	err = tx.QueryRowContext(ctx, `
		SELECT upload_id, agent_id, pack_id, content_length, sha256_hex, blob_key, uploaded, committed, expires_at_ms
		FROM pack_uploads WHERE upload_id = $1 FOR UPDATE
	`, uploadID).Scan(&up.UploadID, &up.AgentID, &up.PackID, &up.ContentLength, &up.SHA256Hex, &up.BlobKey, &up.Uploaded, &up.Committed, &up.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !up.Uploaded || up.AgentID != rec.AgentID || up.PackID != rec.PackID || up.ContentLength != rec.ContentLength || up.SHA256Hex != rec.SHA256Hex {
		return nil, ErrConflict
	}
	if usedBytes+rec.ContentLength > quotaBytes {
		return nil, ErrQuotaExceeded
	}

	var maxSeq uint64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(server_seq), 0) FROM spine_packs WHERE agent_id = $1`, rec.AgentID).Scan(&maxSeq); err != nil {
		return nil, err
	}
	rec.ServerSeq = maxSeq + 1
	rec.BlobKey = up.BlobKey

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO spine_packs (
			agent_id, server_seq, pack_id, device_id, compartment, epoch, first_seq, last_seq,
			min_hlc_hex, max_hlc_hex, padded_len, uncompressed_blake3_hex, aad_utf8,
			dek_wrap_nonce_hex, wrapped_dek_hex, pack_nonce_hex, content_length, sha256_hex, blob_key, created_at_ms
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
	`,
		rec.AgentID, rec.ServerSeq, rec.PackID, rec.DeviceID, rec.Compartment, rec.Epoch, rec.FirstSeq, rec.LastSeq,
		rec.MinHLCHex, rec.MaxHLCHex, rec.PaddedLen, rec.UncompressedBlake3Hex, rec.AADUTF8,
		rec.DEKWrapNonceHex, rec.WrappedDEKHex, rec.PackNonceHex, rec.ContentLength, rec.SHA256Hex, rec.BlobKey, rec.CreatedAtMs,
	); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agents SET used_bytes = used_bytes + $1 WHERE agent_id = $2`, rec.ContentLength, rec.AgentID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE pack_uploads SET committed = TRUE WHERE upload_id = $1`, uploadID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (p *PostgresStore) ListSpinePacks(ctx context.Context, agentID string, afterSeq uint64, limit uint32) ([]SpinePackRecord, error) {
	if limit == 0 || limit > 500 {
		limit = 100
	}
	rows, err := p.db.QueryContext(ctx, `
		SELECT agent_id, server_seq, pack_id, device_id, compartment, epoch, first_seq, last_seq,
		       min_hlc_hex, max_hlc_hex, padded_len, uncompressed_blake3_hex, aad_utf8,
		       dek_wrap_nonce_hex, wrapped_dek_hex, pack_nonce_hex, content_length, sha256_hex, blob_key, created_at_ms
		FROM spine_packs
		WHERE agent_id = $1 AND server_seq > $2
		ORDER BY server_seq ASC
		LIMIT $3
	`, agentID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpinePackRecord
	for rows.Next() {
		var r SpinePackRecord
		if err := rows.Scan(
			&r.AgentID, &r.ServerSeq, &r.PackID, &r.DeviceID, &r.Compartment,
			&r.Epoch, &r.FirstSeq, &r.LastSeq, &r.MinHLCHex, &r.MaxHLCHex,
			&r.PaddedLen, &r.UncompressedBlake3Hex, &r.AADUTF8, &r.DEKWrapNonceHex,
			&r.WrappedDEKHex, &r.PackNonceHex, &r.ContentLength, &r.SHA256Hex,
			&r.BlobKey, &r.CreatedAtMs,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AcquireLease uses PostgreSQL atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE CAS semantics.
func (p *PostgresStore) AcquireLease(ctx context.Context, agentID, deviceID string, expectedEpoch uint64, ttlMs, nowMs int64) (*LeaseRecord, error) {
	expiresAt := nowMs + ttlMs

	if expectedEpoch == 0 {
		var out LeaseRecord
		err := p.db.QueryRowContext(ctx, `
			INSERT INTO leases (agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms)
			VALUES ($1, $2, 1, $3, $4)
			ON CONFLICT (agent_id) DO UPDATE SET
				holder_device_id = EXCLUDED.holder_device_id,
				witness_epoch = CASE
					WHEN leases.holder_device_id = '' OR leases.expires_at_ms <= $4 THEN leases.witness_epoch + 1
					ELSE leases.witness_epoch
				END,
				expires_at_ms = EXCLUDED.expires_at_ms,
				updated_at_ms = EXCLUDED.updated_at_ms
			WHERE leases.holder_device_id = '' OR leases.expires_at_ms <= $4 OR leases.holder_device_id = $2
			RETURNING agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
		`, agentID, deviceID, expiresAt, nowMs).Scan(&out.AgentID, &out.HolderDeviceID, &out.WitnessEpoch, &out.ExpiresAtMs, &out.UpdatedAtMs)
		if err == nil {
			return &out, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}

	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur LeaseRecord
	err = tx.QueryRowContext(ctx, `
		SELECT agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
		FROM leases WHERE agent_id = $1 FOR UPDATE
	`, agentID).Scan(&cur.AgentID, &cur.HolderDeviceID, &cur.WitnessEpoch, &cur.ExpiresAtMs, &cur.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &StaleLeaseError{Provided: expectedEpoch, Current: 0}
	}
	if err != nil {
		return nil, err
	}
	if expectedEpoch > 0 && expectedEpoch != cur.WitnessEpoch {
		return nil, &StaleLeaseError{Provided: expectedEpoch, Current: cur.WitnessEpoch, Holder: cur.HolderDeviceID}
	}
	active := cur.HolderDeviceID != "" && cur.ExpiresAtMs > nowMs
	if active {
		if cur.HolderDeviceID != deviceID {
			return nil, &StaleLeaseError{Provided: expectedEpoch, Current: cur.WitnessEpoch, Holder: cur.HolderDeviceID}
		}
		cur.ExpiresAtMs = expiresAt
		cur.UpdatedAtMs = nowMs
		if _, err := tx.ExecContext(ctx, `
			UPDATE leases SET expires_at_ms = $1, updated_at_ms = $2 WHERE agent_id = $3 AND witness_epoch = $4
		`, cur.ExpiresAtMs, cur.UpdatedAtMs, agentID, cur.WitnessEpoch); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return &cur, nil
	}
	if cur.WitnessEpoch == math.MaxUint64 {
		return nil, errors.New("epoch overflow")
	}
	next := LeaseRecord{
		AgentID:        agentID,
		HolderDeviceID: deviceID,
		WitnessEpoch:   cur.WitnessEpoch + 1,
		ExpiresAtMs:    expiresAt,
		UpdatedAtMs:    nowMs,
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE leases SET holder_device_id = $1, witness_epoch = $2, expires_at_ms = $3, updated_at_ms = $4
		WHERE agent_id = $5 AND witness_epoch = $6
	`, next.HolderDeviceID, next.WitnessEpoch, next.ExpiresAtMs, next.UpdatedAtMs, agentID, cur.WitnessEpoch); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &next, nil
}

func (p *PostgresStore) RenewLease(ctx context.Context, agentID, deviceID string, witnessEpoch uint64, ttlMs, nowMs int64) (*LeaseRecord, error) {
	var out LeaseRecord
	err := p.db.QueryRowContext(ctx, `
		UPDATE leases
		SET expires_at_ms = $1, updated_at_ms = $2
		WHERE agent_id = $3 AND holder_device_id = $4 AND witness_epoch = $5 AND expires_at_ms > $2
		RETURNING agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
	`, nowMs+ttlMs, nowMs, agentID, deviceID, witnessEpoch).Scan(
		&out.AgentID, &out.HolderDeviceID, &out.WitnessEpoch, &out.ExpiresAtMs, &out.UpdatedAtMs,
	)
	if err == nil {
		return &out, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var curEpoch uint64
	var holder string
	_ = p.db.QueryRowContext(ctx, `SELECT witness_epoch, holder_device_id FROM leases WHERE agent_id = $1`, agentID).Scan(&curEpoch, &holder)
	return nil, &StaleLeaseError{Provided: witnessEpoch, Current: curEpoch, Holder: holder}
}

func (p *PostgresStore) ReleaseLease(ctx context.Context, agentID, deviceID string, witnessEpoch uint64, nowMs int64) (*LeaseRecord, error) {
	var out LeaseRecord
	err := p.db.QueryRowContext(ctx, `
		UPDATE leases
		SET holder_device_id = '', expires_at_ms = $1, updated_at_ms = $1
		WHERE agent_id = $2 AND holder_device_id = $3 AND witness_epoch = $4
		RETURNING agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
	`, nowMs, agentID, deviceID, witnessEpoch).Scan(
		&out.AgentID, &out.HolderDeviceID, &out.WitnessEpoch, &out.ExpiresAtMs, &out.UpdatedAtMs,
	)
	if err == nil {
		return &out, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var curEpoch uint64
	var holder string
	_ = p.db.QueryRowContext(ctx, `SELECT witness_epoch, holder_device_id FROM leases WHERE agent_id = $1`, agentID).Scan(&curEpoch, &holder)
	return nil, &StaleLeaseError{Provided: witnessEpoch, Current: curEpoch, Holder: holder}
}

func (p *PostgresStore) CreateGroupRoom(ctx context.Context, room GroupRoom) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO group_rooms (group_id, owner_agent_id, secrecy_level, current_mls_epoch, created_at_ms)
		VALUES ($1, $2, $3, $4, $5)
	`, room.GroupID, room.OwnerAgentID, room.SecrecyLevel, room.CurrentMLSEpoch, room.CreatedAtMs)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return ErrConflict
		}
		return err
	}
	return nil
}

func (p *PostgresStore) GetGroupRoom(ctx context.Context, groupID string) (*GroupRoom, error) {
	var room GroupRoom
	err := p.db.QueryRowContext(ctx, `
		SELECT group_id, owner_agent_id, secrecy_level, current_mls_epoch, created_at_ms
		FROM group_rooms WHERE group_id = $1
	`, groupID).Scan(&room.GroupID, &room.OwnerAgentID, &room.SecrecyLevel, &room.CurrentMLSEpoch, &room.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &room, nil
}

func (p *PostgresStore) ListGroupRooms(ctx context.Context) ([]GroupRoom, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT group_id, owner_agent_id, secrecy_level, current_mls_epoch, created_at_ms
		FROM group_rooms ORDER BY group_id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GroupRoom
	for rows.Next() {
		var room GroupRoom
		if err := rows.Scan(&room.GroupID, &room.OwnerAgentID, &room.SecrecyLevel, &room.CurrentMLSEpoch, &room.CreatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, room)
	}
	return out, rows.Err()
}

func (p *PostgresStore) AddGroupMember(ctx context.Context, member GroupMember) error {
	_, err := p.db.ExecContext(ctx, `
		INSERT INTO group_members (group_id, agent_id, role, added_at_ms)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (group_id, agent_id) DO UPDATE SET role = excluded.role
	`, member.GroupID, member.AgentID, member.Role, member.AddedAtMs)
	return err
}

func (p *PostgresStore) GetGroupMember(ctx context.Context, groupID, agentID string) (*GroupMember, error) {
	var member GroupMember
	err := p.db.QueryRowContext(ctx, `
		SELECT group_id, agent_id, role, added_at_ms
		FROM group_members WHERE group_id = $1 AND agent_id = $2
	`, groupID, agentID).Scan(&member.GroupID, &member.AgentID, &member.Role, &member.AddedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &member, nil
}

func (p *PostgresStore) ListGroupMembers(ctx context.Context, groupID string) ([]GroupMember, error) {
	rows, err := p.db.QueryContext(ctx, `
		SELECT group_id, agent_id, role, added_at_ms
		FROM group_members WHERE group_id = $1 ORDER BY added_at_ms ASC, agent_id ASC
	`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GroupMember
	for rows.Next() {
		var member GroupMember
		if err := rows.Scan(&member.GroupID, &member.AgentID, &member.Role, &member.AddedAtMs); err != nil {
			return nil, err
		}
		out = append(out, member)
	}
	return out, rows.Err()
}

func (p *PostgresStore) AppendGroupCommit(ctx context.Context, commit GroupCommit) (*GroupCommit, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// 行级锁串行化同一群的并发提交，保证 server_seq 严格单调且无空洞。
	var lockedGroup string
	var currentEpoch uint64
	if err := tx.QueryRowContext(ctx, `SELECT group_id, current_mls_epoch FROM group_rooms WHERE group_id = $1 FOR UPDATE`, commit.GroupID).Scan(&lockedGroup, &currentEpoch); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	// 纪元校验必须与追加同事务：持锁读取当前纪元后再判定，杜绝并发陈旧纪元穿透。
	if err := validateEpochAdvance(currentEpoch, commit); err != nil {
		return nil, err
	}
	var nextSeq uint64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) + 1 FROM group_commits WHERE group_id = $1
	`, commit.GroupID).Scan(&nextSeq); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO group_commits (
			group_id, server_seq, mls_epoch, causal_parent_seq, sender_agent_id,
			sender_device_id, mentions_json, ciphertext_b64, kind, author_kind, hop, created_at_ms
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	`, commit.GroupID, nextSeq, commit.MLSEpoch, commit.CausalParentSeq, commit.SenderAgentID,
		commit.SenderDeviceID, commit.MentionsJSON, commit.CiphertextB64, commit.Kind,
		commit.AuthorKind, commit.Hop, commit.CreatedAtMs); err != nil {
		return nil, err
	}
	if commit.MLSEpoch > currentEpoch {
		if _, err := tx.ExecContext(ctx, `
			UPDATE group_rooms SET current_mls_epoch = $1 WHERE group_id = $2
		`, commit.MLSEpoch, commit.GroupID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	commit.ServerSeq = nextSeq
	return &commit, nil
}

func (p *PostgresStore) ListGroupCommits(ctx context.Context, groupID string, afterSeq uint64, limit int) ([]GroupCommit, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := p.db.QueryContext(ctx, `
		SELECT group_id, server_seq, mls_epoch, causal_parent_seq, sender_agent_id,
		       sender_device_id, mentions_json, ciphertext_b64, kind, author_kind, hop, created_at_ms
		FROM group_commits
		WHERE group_id = $1 AND server_seq > $2
		ORDER BY server_seq ASC
		LIMIT $3
	`, groupID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GroupCommit
	for rows.Next() {
		var commit GroupCommit
		if err := rows.Scan(&commit.GroupID, &commit.ServerSeq, &commit.MLSEpoch, &commit.CausalParentSeq,
			&commit.SenderAgentID, &commit.SenderDeviceID, &commit.MentionsJSON, &commit.CiphertextB64,
			&commit.Kind, &commit.AuthorKind, &commit.Hop, &commit.CreatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, commit)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteGroupMember(ctx context.Context, groupID, agentID string) error {
	res, err := p.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id = $1 AND agent_id = $2`, groupID, agentID)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PostgresStore) GetGroupCommit(ctx context.Context, groupID string, serverSeq uint64) (*GroupCommit, error) {
	var commit GroupCommit
	err := p.db.QueryRowContext(ctx, `
		SELECT group_id, server_seq, mls_epoch, causal_parent_seq, sender_agent_id,
		       sender_device_id, mentions_json, ciphertext_b64, kind, author_kind, hop, created_at_ms
		FROM group_commits WHERE group_id = $1 AND server_seq = $2
	`, groupID, serverSeq).Scan(&commit.GroupID, &commit.ServerSeq, &commit.MLSEpoch,
		&commit.CausalParentSeq, &commit.SenderAgentID, &commit.SenderDeviceID,
		&commit.MentionsJSON, &commit.CiphertextB64, &commit.Kind, &commit.AuthorKind,
		&commit.Hop, &commit.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &commit, nil
}

func (p *PostgresStore) GroupRoomHead(ctx context.Context, groupID string) (uint64, uint64, error) {
	var head uint64
	if err := p.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM group_commits WHERE group_id = $1
	`, groupID).Scan(&head); err != nil {
		return 0, 0, err
	}
	var epoch uint64
	err := p.db.QueryRowContext(ctx, `SELECT current_mls_epoch FROM group_rooms WHERE group_id = $1`, groupID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, ErrNotFound
	}
	if err != nil {
		return 0, 0, err
	}
	return head, epoch, nil
}

func (p *PostgresStore) EnqueueWebhookIngress(ctx context.Context, rec WebhookIngressRecord, maxPerAgent int) (bool, int, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	var existing int64
	err = tx.QueryRowContext(ctx, `
		SELECT ingress_id FROM webhook_ingress_queue
		WHERE agent_id = $1 AND channel = $2 AND event_id_hash = $3 AND target_device_id = $4
	`, rec.AgentID, rec.Channel, rec.EventIDHash, rec.TargetDeviceID).Scan(&existing)
	if err == nil {
		var depth int
		if countErr := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1`, rec.AgentID).Scan(&depth); countErr != nil {
			return false, 0, countErr
		}
		return false, depth, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, 0, err
	}

	var depth int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1`, rec.AgentID).Scan(&depth); err != nil {
		return false, 0, err
	}
	var sameEvent int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1 AND channel = $2 AND event_id_hash = $3`, rec.AgentID, rec.Channel, rec.EventIDHash).Scan(&sameEvent); err != nil {
		return false, 0, err
	}
	if maxPerAgent > 0 && depth >= maxPerAgent && sameEvent == 0 {
		return false, depth, ErrQuotaExceeded
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO webhook_ingress_queue (
			agent_id, channel, event_id_hash, target_device_id, hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, rec.AgentID, rec.Channel, rec.EventIDHash, rec.TargetDeviceID, rec.HPKEEncHex, rec.CiphertextHex, rec.AADUTF8, rec.ReceivedAtMs, rec.CreatedAtMs); err != nil {
		return false, 0, err
	}
	if err := tx.Commit(); err != nil {
		return false, 0, err
	}
	return true, depth + 1, nil
}

func (p *PostgresStore) ListWebhookIngress(ctx context.Context, agentID, deviceID string, after int64, limit int) ([]WebhookIngressRecord, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := p.db.QueryContext(ctx, `
		SELECT ingress_id, agent_id, channel, event_id_hash, target_device_id, hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms
		FROM webhook_ingress_queue WHERE agent_id = $1 AND ($2 = '' OR target_device_id = $2 OR target_device_id = '')
		AND ingress_id > $3 ORDER BY ingress_id ASC LIMIT $4
	`, agentID, deviceID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebhookIngressRecord
	for rows.Next() {
		var r WebhookIngressRecord
		if err := rows.Scan(&r.IngressID, &r.AgentID, &r.Channel, &r.EventIDHash, &r.TargetDeviceID, &r.HPKEEncHex, &r.CiphertextHex, &r.AADUTF8, &r.ReceivedAtMs, &r.CreatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *PostgresStore) DeleteWebhookIngress(ctx context.Context, agentID string, ingressID int64) (bool, error) {
	res, err := p.db.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = $1 AND ingress_id = $2`, agentID, ingressID)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

func (p *PostgresStore) CountWebhookIngress(ctx context.Context, agentID string) (int, error) {
	var depth int
	if err := p.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1`, agentID).Scan(&depth); err != nil {
		return 0, err
	}
	return depth, nil
}

func (p *PostgresStore) DeleteWebhookIngressByKeys(ctx context.Context, agentID string, keys []WebhookIngressKey) (int64, error) {
	if len(keys) == 0 {
		return 0, nil
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var deleted int64
	for _, key := range keys {
		res, err := tx.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = $1 AND channel = $2 AND event_id_hash = $3 AND (target_device_id = $4 OR target_device_id = '')`, agentID, key.Channel, key.EventIDHash, key.TargetDeviceID)
		if err != nil {
			return 0, err
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		deleted += affected
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return deleted, nil
}

func (p *PostgresStore) DeleteWebhookIngressForDevice(ctx context.Context, agentID, deviceID string) (int64, error) {
	res, err := p.db.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = $1 AND target_device_id = $2`, agentID, deviceID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresStore) CountWebhookIngressEvents(ctx context.Context, agentID string) (int, error) {
	var count int
	err := p.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM (SELECT DISTINCT channel, event_id_hash FROM webhook_ingress_queue WHERE agent_id = $1) AS events`, agentID).Scan(&count)
	return count, err
}

func (p *PostgresStore) WebhookIngressEventExists(ctx context.Context, agentID, channel, eventIDHash string) (bool, error) {
	var count int
	if err := p.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1 AND channel = $2 AND event_id_hash = $3`, agentID, channel, eventIDHash).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func (p *PostgresStore) DeleteWebhookIngressEvent(ctx context.Context, agentID, channel, eventIDHash string) (int64, error) {
	res, err := p.db.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = $1 AND channel = $2 AND event_id_hash = $3`, agentID, channel, eventIDHash)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (p *PostgresStore) EnqueueWebhookIngressBatch(ctx context.Context, agentID, channel, eventIDHash string, rows []WebhookIngressRow, maxEvents int) (EnqueueOutcome, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return EnqueueOutcome{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1 AND channel = $2 AND event_id_hash = $3`, agentID, channel, eventIDHash).Scan(&existing); err != nil {
		return EnqueueOutcome{}, err
	}
	if existing > 0 {
		var depth int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1`, agentID).Scan(&depth); err != nil {
			return EnqueueOutcome{}, err
		}
		return EnqueueOutcome{Duplicate: true, Depth: depth}, nil
	}
	if maxEvents > 0 {
		var eventCount int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM (SELECT DISTINCT channel, event_id_hash FROM webhook_ingress_queue WHERE agent_id = $1) AS events`, agentID).Scan(&eventCount); err != nil {
			return EnqueueOutcome{}, err
		}
		if eventCount >= maxEvents {
			return EnqueueOutcome{}, ErrQuotaExceeded
		}
	}
	for _, row := range rows {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO webhook_ingress_queue (
				agent_id, channel, event_id_hash, target_device_id, hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		`, agentID, channel, eventIDHash, row.TargetDeviceID, row.HPKEEncHex, row.CiphertextHex, row.AADUTF8, row.ReceivedAtMs, row.CreatedAtMs); err != nil {
			return EnqueueOutcome{}, err
		}
	}
	var depth int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = $1`, agentID).Scan(&depth); err != nil {
		return EnqueueOutcome{}, err
	}
	if err := tx.Commit(); err != nil {
		return EnqueueOutcome{}, err
	}
	return EnqueueOutcome{Depth: depth}, nil
}

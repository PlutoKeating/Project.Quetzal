// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

var (
	ErrNotImplemented  = errors.New("not implemented")
	ErrNotFound        = errors.New("not found")
	ErrConflict        = errors.New("conflict")
	ErrEpochConflict   = errors.New("mls epoch conflict")
	ErrQuotaExceeded   = errors.New("quota exceeded")
	ErrStaleLeaseEpoch = errors.New("stale lease epoch")
	ErrLocked          = errors.New("locked")
	ErrExpired         = errors.New("expired")
)

type StaleLeaseError struct {
	Provided uint64
	Current  uint64
	Holder   string
}

func (e *StaleLeaseError) Error() string {
	return fmt.Sprintf("stale lease epoch (provided=%d, current=%d, holder=%s)", e.Provided, e.Current, e.Holder)
}

func (e *StaleLeaseError) Is(target error) bool {
	return target == ErrStaleLeaseEpoch
}

type Account struct {
	AccountID   string
	OIDCIssuer  string
	OIDCSubject string
	CreatedAtMs int64
}

type Agent struct {
	AgentID             string
	OwnerAccountID      string
	RootVerifyingKeyHex string
	QuotaBytes          int64
	UsedBytes           int64
	CreatedAtMs         int64
}

type Device struct {
	AgentID          string
	DeviceID         string
	AccountID        string
	Ed25519PubKeyHex string
	XWingPubKeyHex   string
	Revoked          bool
	CreatedAtMs      int64
}

type Session struct {
	TokenSHA256Hex string
	AccountID      string
	AgentID        string
	DeviceID       string
	ExpiresAtMs    int64
	CreatedAtMs    int64
}

type KeySlotEnvelope struct {
	AgentID       string `json:"agent_id"`
	Slot          string `json:"slot"`
	AADUTF8       string `json:"aad_utf8"`
	NonceHex      string `json:"nonce_hex"`
	CiphertextHex string `json:"ciphertext_hex"`
	HPKEEncHex    string `json:"hpke_enc_hex,omitempty"`
	MetadataJSON  string `json:"metadata_json,omitempty"`
	UpdatedAtMs   int64  `json:"updated_at_ms"`
}

type PasskeyCredential struct {
	CredentialID string
	AccountID    string
	AgentID      string
	Alg          int
	PublicKeyHex string
	SignCount    uint32
	PRFSaltHex   string
	CreatedAtMs  int64
}

type AuthChallenge struct {
	ChallengeID       string
	Purpose           string
	ChallengeBytesHex string
	AccountID         string
	AgentID           string
	PayloadJSON       string
	ExpiresAtMs       int64
	Consumed          bool
}

type OpaqueRegistration struct {
	AgentID              string
	AccountID            string
	CredentialIdentifier string
	ClientPublicKeyHex   string
	MaskingKeyHex        string
	EnvelopeHex          string
	OPRFKeyScalarHex     string
	UpdatedAtMs          int64
}

type OpaqueLoginState struct {
	LoginID      string
	AgentID      string
	AccountID    string
	DeviceID     string
	KM3Hex       string
	PreambleHex  string
	ServerMACHex string
	ExpiresAtMs  int64
	Consumed     bool
}

type PairingSession struct {
	PairingID           string
	ShortCodeHMACHex    string
	AgentID             string
	InitiatorAccountID  string
	NewDeviceID         string
	NewDeviceEd25519Hex string
	NewDeviceXWingPKHex string
	HPKEEncHex          string
	CiphertextHex       string
	AADUTF8             string
	FailedAttempts      int
	MaxAttempts         int
	Locked              bool
	Consumed            bool
	ExpiresAtMs         int64
}

type GuardianConfig struct {
	AgentID             string `json:"agent_id"`
	Threshold           int    `json:"threshold"`
	Total               int    `json:"total"`
	CommitmentBlake3Hex string `json:"commitment_blake3_hex"`
	UpdatedAtMs         int64  `json:"updated_at_ms"`
}

type GuardianShareCustody struct {
	AgentID           string `json:"agent_id"`
	ShareIndex        int    `json:"share_index"`
	GuardianID        string `json:"guardian_id"`
	GuardianPubKeyHex string `json:"guardian_pubkey_hex"`
	EncryptedShareHex string `json:"encrypted_share_hex"`
	HPKEEncHex        string `json:"hpke_enc_hex,omitempty"`
	AADUTF8           string `json:"aad_utf8"`
}

type GuardianRecovery struct {
	RecoveryID          string
	AgentID             string
	RequesterXWingPKHex string
	ExpiresAtMs         int64
	CreatedAtMs         int64
}

type GuardianApproval struct {
	RecoveryID          string `json:"recovery_id"`
	ShareIndex          int    `json:"share_index"`
	GuardianID          string `json:"guardian_id"`
	SignatureHex        string `json:"signature_hex"`
	RewrappedShareHex   string `json:"rewrapped_share_hex,omitempty"`
	RewrappedHPKEEncHex string `json:"rewrapped_hpke_enc_hex,omitempty"`
	ApprovedAtMs        int64  `json:"approved_at_ms"`
}

type PackUpload struct {
	UploadID      string
	AgentID       string
	PackID        string
	ContentLength int64
	SHA256Hex     string
	BlobKey       string
	Uploaded      bool
	Committed     bool
	ExpiresAtMs   int64
}

type PackAad struct {
	AgentID            string `json:"agent_id"`
	Compartment        string `json:"compartment"`
	DeviceID           string `json:"device_id"`
	Epoch              uint64 `json:"epoch"`
	FirstSeq           uint64 `json:"first_seq"`
	LastSeq            uint64 `json:"last_seq"`
	MaxHLC             string `json:"max_hlc"`
	MinHLC             string `json:"min_hlc"`
	PaddedLen          int    `json:"padded_len"`
	UncompressedBlake3 string `json:"uncompressed_blake3"`
	V                  uint32 `json:"v"`
}

func (a PackAad) CanonicalJSON() string {
	return fmt.Sprintf(
		`{"agent_id":"%s","compartment":"%s","device_id":"%s","epoch":%d,"first_seq":%d,"last_seq":%d,"max_hlc":"%s","min_hlc":"%s","padded_len":%d,"uncompressed_blake3":"%s","v":%d}`,
		a.AgentID,
		a.Compartment,
		a.DeviceID,
		a.Epoch,
		a.FirstSeq,
		a.LastSeq,
		a.MaxHLC,
		a.MinHLC,
		a.PaddedLen,
		a.UncompressedBlake3,
		a.V,
	)
}

type SpinePackRecord struct {
	AgentID               string `json:"agent_id"`
	ServerSeq             uint64 `json:"server_seq"`
	PackID                string `json:"pack_id"`
	DeviceID              string `json:"device_id"`
	Compartment           string `json:"compartment"`
	Epoch                 uint64 `json:"epoch"`
	FirstSeq              uint64 `json:"first_seq"`
	LastSeq               uint64 `json:"last_seq"`
	MinHLCHex             string `json:"min_hlc"`
	MaxHLCHex             string `json:"max_hlc"`
	PaddedLen             int    `json:"padded_len"`
	UncompressedBlake3Hex string `json:"uncompressed_blake3"`
	AADUTF8               string `json:"aad_utf8"`
	DEKWrapNonceHex       string `json:"dek_wrap_nonce_hex"`
	WrappedDEKHex         string `json:"wrapped_dek_hex"`
	PackNonceHex          string `json:"pack_nonce_hex"`
	ContentLength         int64  `json:"content_length"`
	SHA256Hex             string `json:"sha256_hex"`
	BlobKey               string `json:"-"`
	CreatedAtMs           int64  `json:"created_at_ms"`
	DownloadURL           string `json:"download_url,omitempty"`
}

// WebhookIngressRecord 是公网 Webhook 的零知识密文队列行。
// 仅保存 HPKE 封装、密文、AAD 与不可解析的投递元数据，绝不含平台明文正文。
type WebhookIngressRecord struct {
	IngressID      int64  `json:"ingress_id"`
	AgentID        string `json:"agent_id"`
	Channel        string `json:"channel"`
	EventIDHash    string `json:"event_id_hash"`
	TargetDeviceID string `json:"target_device_id"`
	HPKEEncHex     string `json:"hpke_enc_hex"`
	CiphertextHex  string `json:"ciphertext_hex"`
	AADUTF8        string `json:"aad_utf8"`
	ReceivedAtMs   int64  `json:"received_at_ms"`
	CreatedAtMs    int64  `json:"created_at_ms"`
}

type LeaseRecord struct {
	AgentID        string `json:"agent_id"`
	HolderDeviceID string `json:"holder_device_id"`
	WitnessEpoch   uint64 `json:"witness_epoch"`
	ExpiresAtMs    int64  `json:"expires_at_ms"`
	UpdatedAtMs    int64  `json:"updated_at_ms"`
}

// GroupRoom 是零知识群房间元数据（无任何明文提示词、记忆或人格内容）。
type GroupRoom struct {
	GroupID         string `json:"group_id"`
	OwnerAgentID    string `json:"owner_agent_id"`
	SecrecyLevel    int    `json:"secrecy_level"`
	CurrentMLSEpoch uint64 `json:"current_mls_epoch"`
	CreatedAtMs     int64  `json:"created_at_ms"`
}

// GroupMember 绑定群房间与主权 Agent 成员身份。
type GroupMember struct {
	GroupID   string `json:"group_id"`
	AgentID   string `json:"agent_id"`
	Role      string `json:"role"`
	AddedAtMs int64  `json:"added_at_ms"`
}

// GroupCommit 只保存 openmls 密文与可审计定序元数据，严禁任何业务明文。
type GroupCommit struct {
	GroupID         string `json:"group_id"`
	ServerSeq       uint64 `json:"server_seq"`
	MLSEpoch        uint64 `json:"mls_epoch"`
	CausalParentSeq uint64 `json:"causal_parent_seq"`
	SenderAgentID   string `json:"sender_agent_id"`
	SenderDeviceID  string `json:"sender_device_id"`
	MentionsJSON    string `json:"mentions"`
	CiphertextB64   string `json:"ciphertext_b64"`
	Kind            string `json:"kind"`
	AuthorKind      string `json:"author_kind"`
	Hop             int    `json:"hop"`
	CreatedAtMs     int64  `json:"created_at_ms"`
	// ReencryptOnly 标记“同一密文纯密钥轮换”，仅用于纪元校验，不落库。
	ReencryptOnly bool `json:"-"`
}

// validateEpochAdvance 是纪元写入门禁的唯一实现：
//   - 持平只允许普通提交（`reencrypt_only = false`）；
//   - 恰 +1 必须标记纯密钥轮换，且每个纪元只允许被建立一个——后来者一律冲突，
//     否则两个成员可各自落到不同的 E+1 提交上，群会永久分叉。
func validateEpochAdvance(current uint64, commit GroupCommit) error {
	switch {
	case commit.MLSEpoch < current:
		return ErrEpochConflict
	case commit.MLSEpoch == current:
		if commit.ReencryptOnly {
			return ErrEpochConflict
		}
		return nil
	case commit.MLSEpoch != current+1 || !commit.ReencryptOnly:
		return ErrEpochConflict
	default:
		return nil
	}
}

type Store interface {
	Close() error

	CreateAccount(ctx context.Context, acc Account) error
	GetAccountByOIDC(ctx context.Context, issuer, subject string) (*Account, error)
	DeleteAccountByOIDC(ctx context.Context, issuer, subject string) ([]string, error)
	DeleteAccount(ctx context.Context, accountID string) ([]string, error)

	CreateAgent(ctx context.Context, agent Agent) error
	GetAgent(ctx context.Context, agentID string) (*Agent, error)
	SetAgentQuota(ctx context.Context, agentID string, quotaBytes int64) error

	UpsertDevice(ctx context.Context, dev Device) error
	GetDevice(ctx context.Context, agentID, deviceID string) (*Device, error)
	ListDevices(ctx context.Context, agentID string) ([]Device, error)

	CreateSession(ctx context.Context, sess Session) error
	GetSession(ctx context.Context, tokenSHA256Hex string) (*Session, error)

	UpsertKeySlot(ctx context.Context, slot KeySlotEnvelope) error
	GetKeySlot(ctx context.Context, agentID, slotType string) (*KeySlotEnvelope, error)
	ListKeySlots(ctx context.Context, agentID string) ([]KeySlotEnvelope, error)

	SaveChallenge(ctx context.Context, ch AuthChallenge) error
	ConsumeChallenge(ctx context.Context, challengeID, purpose string, nowMs int64) (*AuthChallenge, error)

	SavePasskeyCredential(ctx context.Context, cred PasskeyCredential) error
	GetPasskeyCredential(ctx context.Context, credentialID string) (*PasskeyCredential, error)
	ListPasskeyCredentialsByAgent(ctx context.Context, agentID string) ([]PasskeyCredential, error)
	UpdatePasskeySignCount(ctx context.Context, credentialID string, signCount uint32) error

	UpsertOpaqueRegistration(ctx context.Context, reg OpaqueRegistration) error
	GetOpaqueRegistration(ctx context.Context, agentID string) (*OpaqueRegistration, error)
	SaveOpaqueLoginState(ctx context.Context, st OpaqueLoginState) error
	ConsumeOpaqueLoginState(ctx context.Context, loginID string, nowMs int64) (*OpaqueLoginState, error)

	CreatePairingSession(ctx context.Context, ps PairingSession) error
	GetPairingSession(ctx context.Context, pairingID string) (*PairingSession, error)
	RecordPairingAttempt(ctx context.Context, pairingID, expectedShortCodeHMACHex, providedHMACHex string, nowMs int64) (*PairingSession, bool, error)
	UpdatePairingJoiner(ctx context.Context, pairingID, newDevID, newEdHex, newXWingHex string) error
	ApprovePairingSession(ctx context.Context, pairingID, hpkeEncHex, ciphertextHex, aadUTF8 string) error
	ConsumePairingSession(ctx context.Context, pairingID string, nowMs int64) (*PairingSession, error)

	SaveGuardianSetup(ctx context.Context, cfg GuardianConfig, shares []GuardianShareCustody) error
	GetGuardianSetup(ctx context.Context, agentID string) (*GuardianConfig, []GuardianShareCustody, error)
	CreateGuardianRecovery(ctx context.Context, rec GuardianRecovery) error
	GetGuardianRecovery(ctx context.Context, recoveryID string) (*GuardianRecovery, error)
	AddGuardianApproval(ctx context.Context, app GuardianApproval) error
	ListGuardianApprovals(ctx context.Context, recoveryID string) ([]GuardianApproval, error)

	CreatePackUpload(ctx context.Context, up PackUpload) error
	GetPackUpload(ctx context.Context, uploadID string) (*PackUpload, error)
	MarkPackUploaded(ctx context.Context, uploadID string) error
	CommitSpinePack(ctx context.Context, uploadID string, rec SpinePackRecord) (*SpinePackRecord, error)
	ListSpinePacks(ctx context.Context, agentID string, afterSeq uint64, limit uint32) ([]SpinePackRecord, error)

	EnqueueWebhookIngress(ctx context.Context, rec WebhookIngressRecord, maxPerAgent int) (bool, int, error)
	ListWebhookIngress(ctx context.Context, agentID, deviceID string, after int64, limit int) ([]WebhookIngressRecord, error)
	DeleteWebhookIngress(ctx context.Context, agentID string, ingressID int64) (bool, error)
	DeleteWebhookIngressByKeys(ctx context.Context, agentID string, keys []WebhookIngressKey) (int64, error)
	CountWebhookIngress(ctx context.Context, agentID string) (int, error)
	DeleteWebhookIngressForDevice(ctx context.Context, agentID, deviceID string) (int64, error)
	CountWebhookIngressEvents(ctx context.Context, agentID string) (int, error)
	WebhookIngressEventExists(ctx context.Context, agentID, channel, eventIDHash string) (bool, error)
	DeleteWebhookIngressEvent(ctx context.Context, agentID, channel, eventIDHash string) (int64, error)

	AcquireLease(ctx context.Context, agentID, deviceID string, expectedEpoch uint64, ttlMs, nowMs int64) (*LeaseRecord, error)
	RenewLease(ctx context.Context, agentID, deviceID string, witnessEpoch uint64, ttlMs, nowMs int64) (*LeaseRecord, error)
	ReleaseLease(ctx context.Context, agentID, deviceID string, witnessEpoch uint64, nowMs int64) (*LeaseRecord, error)

	CreateGroupRoom(ctx context.Context, room GroupRoom) error
	GetGroupRoom(ctx context.Context, groupID string) (*GroupRoom, error)
	ListGroupRooms(ctx context.Context) ([]GroupRoom, error)
	AddGroupMember(ctx context.Context, member GroupMember) error
	GetGroupMember(ctx context.Context, groupID, agentID string) (*GroupMember, error)
	ListGroupMembers(ctx context.Context, groupID string) ([]GroupMember, error)
	DeleteGroupMember(ctx context.Context, groupID, agentID string) error
	AppendGroupCommit(ctx context.Context, commit GroupCommit) (*GroupCommit, error)
	GetGroupCommit(ctx context.Context, groupID string, serverSeq uint64) (*GroupCommit, error)
	ListGroupCommits(ctx context.Context, groupID string, afterSeq uint64, limit int) ([]GroupCommit, error)
	GroupRoomHead(ctx context.Context, groupID string) (uint64, uint64, error)
}

const sqliteSchemaDDL = `
CREATE TABLE IF NOT EXISTS accounts (
	account_id TEXT PRIMARY KEY,
	oidc_issuer TEXT NOT NULL DEFAULT '',
	oidc_subject TEXT NOT NULL DEFAULT '',
	created_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_oidc
	ON accounts(oidc_issuer, oidc_subject)
	WHERE oidc_issuer != '' AND oidc_subject != '';

CREATE TABLE IF NOT EXISTS agents (
	agent_id TEXT PRIMARY KEY,
	owner_account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	root_verifying_key_hex TEXT NOT NULL,
	quota_bytes INTEGER NOT NULL,
	used_bytes INTEGER NOT NULL DEFAULT 0,
	created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	device_id TEXT NOT NULL,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	ed25519_pubkey_hex TEXT NOT NULL,
	xwing_pubkey_hex TEXT NOT NULL,
	revoked INTEGER NOT NULL DEFAULT 0,
	created_at_ms INTEGER NOT NULL,
	PRIMARY KEY (agent_id, device_id)
);

CREATE TABLE IF NOT EXISTS sessions (
	token_sha256_hex TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	expires_at_ms INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS key_slots (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	slot_type TEXT NOT NULL,
	aad_utf8 TEXT NOT NULL,
	nonce_hex TEXT NOT NULL,
	ciphertext_hex TEXT NOT NULL,
	hpke_enc_hex TEXT NOT NULL DEFAULT '',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	updated_at_ms INTEGER NOT NULL,
	PRIMARY KEY (agent_id, slot_type)
);

CREATE TABLE IF NOT EXISTS auth_challenges (
	challenge_id TEXT PRIMARY KEY,
	purpose TEXT NOT NULL,
	challenge_bytes_hex TEXT NOT NULL,
	account_id TEXT NOT NULL DEFAULT '',
	agent_id TEXT NOT NULL DEFAULT '',
	payload_json TEXT NOT NULL DEFAULT '{}',
	expires_at_ms INTEGER NOT NULL,
	consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
	credential_id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	alg INTEGER NOT NULL,
	public_key_hex TEXT NOT NULL,
	sign_count INTEGER NOT NULL DEFAULT 0,
	prf_salt_hex TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opaque_registrations (
	agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	credential_identifier TEXT NOT NULL,
	client_public_key_hex TEXT NOT NULL,
	masking_key_hex TEXT NOT NULL,
	envelope_hex TEXT NOT NULL,
	oprf_key_scalar_hex TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opaque_login_states (
	login_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
	device_id TEXT NOT NULL,
	km3_hex TEXT NOT NULL,
	preamble_hex TEXT NOT NULL,
	server_mac_hex TEXT NOT NULL,
	expires_at_ms INTEGER NOT NULL,
	consumed INTEGER NOT NULL DEFAULT 0
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
	locked INTEGER NOT NULL DEFAULT 0,
	consumed INTEGER NOT NULL DEFAULT 0,
	expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guardian_configs (
	agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
	threshold INTEGER NOT NULL,
	total INTEGER NOT NULL,
	commitment_blake3_hex TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL
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
	expires_at_ms INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guardian_approvals (
	recovery_id TEXT NOT NULL REFERENCES guardian_recoveries(recovery_id) ON DELETE CASCADE,
	share_index INTEGER NOT NULL,
	guardian_id TEXT NOT NULL,
	signature_hex TEXT NOT NULL,
	rewrapped_share_hex TEXT NOT NULL DEFAULT '',
	rewrapped_hpke_enc_hex TEXT NOT NULL DEFAULT '',
	approved_at_ms INTEGER NOT NULL,
	PRIMARY KEY (recovery_id, share_index)
);

CREATE TABLE IF NOT EXISTS pack_uploads (
	upload_id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	pack_id TEXT NOT NULL,
	content_length INTEGER NOT NULL,
	sha256_hex TEXT NOT NULL,
	blob_key TEXT NOT NULL,
	uploaded INTEGER NOT NULL DEFAULT 0,
	committed INTEGER NOT NULL DEFAULT 0,
	expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spine_packs (
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	server_seq INTEGER NOT NULL,
	pack_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	compartment TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	first_seq INTEGER NOT NULL,
	last_seq INTEGER NOT NULL,
	min_hlc_hex TEXT NOT NULL,
	max_hlc_hex TEXT NOT NULL,
	padded_len INTEGER NOT NULL,
	uncompressed_blake3_hex TEXT NOT NULL,
	aad_utf8 TEXT NOT NULL,
	dek_wrap_nonce_hex TEXT NOT NULL,
	wrapped_dek_hex TEXT NOT NULL,
	pack_nonce_hex TEXT NOT NULL,
	content_length INTEGER NOT NULL,
	sha256_hex TEXT NOT NULL,
	blob_key TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	PRIMARY KEY (agent_id, server_seq),
	UNIQUE (agent_id, pack_id)
);

CREATE TABLE IF NOT EXISTS leases (
	agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
	holder_device_id TEXT NOT NULL DEFAULT '',
	witness_epoch INTEGER NOT NULL,
	expires_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_rooms (
	group_id TEXT PRIMARY KEY,
	owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	secrecy_level INTEGER NOT NULL,
	current_mls_epoch INTEGER NOT NULL DEFAULT 0,
	created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
	group_id TEXT NOT NULL REFERENCES group_rooms(group_id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	added_at_ms INTEGER NOT NULL,
	PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE IF NOT EXISTS group_commits (
	group_id TEXT NOT NULL REFERENCES group_rooms(group_id) ON DELETE CASCADE,
	server_seq INTEGER NOT NULL,
	mls_epoch INTEGER NOT NULL,
	causal_parent_seq INTEGER NOT NULL,
	sender_agent_id TEXT NOT NULL,
	sender_device_id TEXT NOT NULL,
	mentions_json TEXT NOT NULL,
	ciphertext_b64 TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'message',
	author_kind TEXT NOT NULL DEFAULT 'human',
	hop INTEGER NOT NULL DEFAULT 0,
	created_at_ms INTEGER NOT NULL,
	PRIMARY KEY (group_id, server_seq)
);

CREATE TABLE IF NOT EXISTS webhook_ingress_queue (
	ingress_id INTEGER PRIMARY KEY AUTOINCREMENT,
	agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	event_id_hash TEXT NOT NULL,
	target_device_id TEXT NOT NULL DEFAULT '',
	hpke_enc_hex TEXT NOT NULL,
	ciphertext_hex TEXT NOT NULL,
	aad_utf8 TEXT NOT NULL,
	received_at_ms INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL,
	UNIQUE (agent_id, channel, event_id_hash, target_device_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_ingress_agent
	ON webhook_ingress_queue(agent_id, ingress_id);
`

// SchemaDDLForParityTest exposes the SQLite and PostgreSQL DDL strings so automated tests
// enforce strict single-source table and column parity across both database backends.
func SchemaDDLForParityTest() (sqliteDDL, postgresDDL string) {
	return sqliteSchemaDDL, postgresSchemaDDL
}

type SQLiteStore struct {
	mu sync.Mutex
	db *sql.DB
}

var _ Store = (*SQLiteStore)(nil)

func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	if dbPath != ":memory:" && dbPath != "" {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
			return nil, fmt.Errorf("create sqlite parent dir: %w", err)
		}
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	pragmas := []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA foreign_keys = ON;",
		"PRAGMA busy_timeout = 10000;",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("exec pragma %s: %w", p, err)
		}
	}
	if _, err := db.Exec(sqliteSchemaDDL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init sqlite schema: %w", err)
	}
	if err := migrateSQLiteGroupSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate sqlite group schema: %w", err)
	}
	if err := migrateSQLiteWebhookSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate sqlite webhook schema: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

// migrateSQLiteWebhookSchema 为 Fix Round 1 之前的单设备入站表补齐 target_device_id
// 并重建唯一约束为 (agent_id, channel, event_id_hash, target_device_id)。
func migrateSQLiteWebhookSchema(db *sql.DB) error {
	exists, err := sqliteTableHasColumn(db, "webhook_ingress_queue", "target_device_id")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`CREATE TABLE webhook_ingress_queue_v2 (
		ingress_id INTEGER PRIMARY KEY AUTOINCREMENT,
		agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
		channel TEXT NOT NULL,
		event_id_hash TEXT NOT NULL,
		target_device_id TEXT NOT NULL DEFAULT '',
		hpke_enc_hex TEXT NOT NULL,
		ciphertext_hex TEXT NOT NULL,
		aad_utf8 TEXT NOT NULL,
		received_at_ms INTEGER NOT NULL,
		created_at_ms INTEGER NOT NULL,
		UNIQUE (agent_id, channel, event_id_hash, target_device_id)
	);`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO webhook_ingress_queue_v2
		(ingress_id, agent_id, channel, event_id_hash, target_device_id, hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms)
		SELECT ingress_id, agent_id, channel, event_id_hash, '', hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms
		FROM webhook_ingress_queue;`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE webhook_ingress_queue;`); err != nil {
		return err
	}
	if _, err := tx.Exec(`ALTER TABLE webhook_ingress_queue_v2 RENAME TO webhook_ingress_queue;`); err != nil {
		return err
	}
	if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_webhook_ingress_agent ON webhook_ingress_queue(agent_id, ingress_id);`); err != nil {
		return err
	}
	return tx.Commit()
}

// migrateSQLiteGroupSchema 为 Fix Round 1 之前创建的旧数据目录补齐群组新列。
// 迁移幂等：先查 PRAGMA table_info，缺列才 ALTER，重启多次也不会重复添加。
func migrateSQLiteGroupSchema(db *sql.DB) error {
	columns := []struct {
		table  string
		column string
		ddl    string
	}{
		{"group_rooms", "current_mls_epoch",
			`ALTER TABLE group_rooms ADD COLUMN current_mls_epoch INTEGER NOT NULL DEFAULT 0`},
		{"group_commits", "kind",
			`ALTER TABLE group_commits ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'`},
		{"group_commits", "author_kind",
			`ALTER TABLE group_commits ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'human'`},
		{"group_commits", "hop",
			`ALTER TABLE group_commits ADD COLUMN hop INTEGER NOT NULL DEFAULT 0`},
	}
	for _, col := range columns {
		exists, err := sqliteTableHasColumn(db, col.table, col.column)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := db.Exec(col.ddl); err != nil {
			return fmt.Errorf("add %s.%s: %w", col.table, col.column, err)
		}
	}
	return nil
}

func sqliteTableHasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, fmt.Errorf("inspect %s columns: %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			cid       int
			name      string
			columnTyp string
			notNull   int
			defaultV  any
			pk        int
		)
		if err := rows.Scan(&cid, &name, &columnTyp, &notNull, &defaultV, &pk); err != nil {
			return false, fmt.Errorf("scan %s columns: %w", table, err)
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *SQLiteStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Close()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *SQLiteStore) CreateAccount(ctx context.Context, acc Account) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO accounts (account_id, oidc_issuer, oidc_subject, created_at_ms) VALUES (?, ?, ?, ?)`,
		acc.AccountID, acc.OIDCIssuer, acc.OIDCSubject, acc.CreatedAtMs,
	)
	return err
}

func (s *SQLiteStore) GetAccountByOIDC(ctx context.Context, issuer, subject string) (*Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var acc Account
	err := s.db.QueryRowContext(ctx,
		`SELECT account_id, oidc_issuer, oidc_subject, created_at_ms FROM accounts WHERE oidc_issuer = ? AND oidc_subject = ?`,
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

func (s *SQLiteStore) DeleteAccountByOIDC(ctx context.Context, issuer, subject string) ([]string, error) {
	acc, err := s.GetAccountByOIDC(ctx, issuer, subject)
	if err != nil {
		return nil, err
	}
	return s.DeleteAccount(ctx, acc.AccountID)
}

func (s *SQLiteStore) DeleteAccount(ctx context.Context, accountID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
		SELECT DISTINCT sp.blob_key
		FROM spine_packs sp
		JOIN agents ag ON ag.agent_id = sp.agent_id
		WHERE ag.owner_account_id = ?
		UNION
		SELECT DISTINCT pu.blob_key
		FROM pack_uploads pu
		JOIN agents ag ON ag.agent_id = pu.agent_id
		WHERE ag.owner_account_id = ?
	`, accountID, accountID)
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

	res, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE account_id = ?`, accountID)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return blobKeys, nil
}

func (s *SQLiteStore) CreateAgent(ctx context.Context, agent Agent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO agents (agent_id, owner_account_id, root_verifying_key_hex, quota_bytes, used_bytes, created_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		agent.AgentID, agent.OwnerAccountID, agent.RootVerifyingKeyHex, agent.QuotaBytes, agent.UsedBytes, agent.CreatedAtMs,
	)
	return err
}

func (s *SQLiteStore) GetAgent(ctx context.Context, agentID string) (*Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ag Agent
	err := s.db.QueryRowContext(ctx,
		`SELECT agent_id, owner_account_id, root_verifying_key_hex, quota_bytes, used_bytes, created_at_ms
		 FROM agents WHERE agent_id = ?`, agentID,
	).Scan(&ag.AgentID, &ag.OwnerAccountID, &ag.RootVerifyingKeyHex, &ag.QuotaBytes, &ag.UsedBytes, &ag.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &ag, nil
}

func (s *SQLiteStore) SetAgentQuota(ctx context.Context, agentID string, quotaBytes int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `UPDATE agents SET quota_bytes = ? WHERE agent_id = ?`, quotaBytes, agentID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) UpsertDevice(ctx context.Context, dev Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO devices (agent_id, device_id, account_id, ed25519_pubkey_hex, xwing_pubkey_hex, revoked, created_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id, device_id) DO UPDATE SET
			ed25519_pubkey_hex = excluded.ed25519_pubkey_hex,
			xwing_pubkey_hex = excluded.xwing_pubkey_hex,
			revoked = excluded.revoked
	`, dev.AgentID, dev.DeviceID, dev.AccountID, dev.Ed25519PubKeyHex, dev.XWingPubKeyHex, boolToInt(dev.Revoked), dev.CreatedAtMs)
	return err
}

func (s *SQLiteStore) GetDevice(ctx context.Context, agentID, deviceID string) (*Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var dev Device
	var rev int
	err := s.db.QueryRowContext(ctx, `
		SELECT agent_id, device_id, account_id, ed25519_pubkey_hex, xwing_pubkey_hex, revoked, created_at_ms
		FROM devices WHERE agent_id = ? AND device_id = ?
	`, agentID, deviceID).Scan(&dev.AgentID, &dev.DeviceID, &dev.AccountID, &dev.Ed25519PubKeyHex, &dev.XWingPubKeyHex, &rev, &dev.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	dev.Revoked = rev != 0
	return &dev, nil
}

func (s *SQLiteStore) ListDevices(ctx context.Context, agentID string) ([]Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT agent_id, device_id, account_id, ed25519_pubkey_hex, xwing_pubkey_hex, revoked, created_at_ms
		FROM devices WHERE agent_id = ? ORDER BY created_at_ms ASC, device_id ASC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Device
	for rows.Next() {
		var dev Device
		var rev int
		if err := rows.Scan(&dev.AgentID, &dev.DeviceID, &dev.AccountID, &dev.Ed25519PubKeyHex, &dev.XWingPubKeyHex, &rev, &dev.CreatedAtMs); err != nil {
			return nil, err
		}
		dev.Revoked = rev != 0
		out = append(out, dev)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) CreateSession(ctx context.Context, sess Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sessions (token_sha256_hex, account_id, agent_id, device_id, expires_at_ms, created_at_ms)
		VALUES (?, ?, ?, ?, ?, ?)
	`, sess.TokenSHA256Hex, sess.AccountID, sess.AgentID, sess.DeviceID, sess.ExpiresAtMs, sess.CreatedAtMs)
	return err
}

func (s *SQLiteStore) GetSession(ctx context.Context, tokenSHA256Hex string) (*Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var sess Session
	err := s.db.QueryRowContext(ctx, `
		SELECT token_sha256_hex, account_id, agent_id, device_id, expires_at_ms, created_at_ms
		FROM sessions WHERE token_sha256_hex = ?
	`, tokenSHA256Hex).Scan(&sess.TokenSHA256Hex, &sess.AccountID, &sess.AgentID, &sess.DeviceID, &sess.ExpiresAtMs, &sess.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *SQLiteStore) UpsertKeySlot(ctx context.Context, slot KeySlotEnvelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slot.MetadataJSON == "" {
		slot.MetadataJSON = "{}"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO key_slots (agent_id, slot_type, aad_utf8, nonce_hex, ciphertext_hex, hpke_enc_hex, metadata_json, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id, slot_type) DO UPDATE SET
			aad_utf8 = excluded.aad_utf8,
			nonce_hex = excluded.nonce_hex,
			ciphertext_hex = excluded.ciphertext_hex,
			hpke_enc_hex = excluded.hpke_enc_hex,
			metadata_json = excluded.metadata_json,
			updated_at_ms = excluded.updated_at_ms
	`, slot.AgentID, slot.Slot, slot.AADUTF8, slot.NonceHex, slot.CiphertextHex, slot.HPKEEncHex, slot.MetadataJSON, slot.UpdatedAtMs)
	return err
}

func (s *SQLiteStore) GetKeySlot(ctx context.Context, agentID, slotType string) (*KeySlotEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var slot KeySlotEnvelope
	err := s.db.QueryRowContext(ctx, `
		SELECT agent_id, slot_type, aad_utf8, nonce_hex, ciphertext_hex, hpke_enc_hex, metadata_json, updated_at_ms
		FROM key_slots WHERE agent_id = ? AND slot_type = ?
	`, agentID, slotType).Scan(&slot.AgentID, &slot.Slot, &slot.AADUTF8, &slot.NonceHex, &slot.CiphertextHex, &slot.HPKEEncHex, &slot.MetadataJSON, &slot.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &slot, nil
}

func (s *SQLiteStore) ListKeySlots(ctx context.Context, agentID string) ([]KeySlotEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT agent_id, slot_type, aad_utf8, nonce_hex, ciphertext_hex, hpke_enc_hex, metadata_json, updated_at_ms
		FROM key_slots WHERE agent_id = ? ORDER BY slot_type ASC
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

func (s *SQLiteStore) SaveChallenge(ctx context.Context, ch AuthChallenge) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch.PayloadJSON == "" {
		ch.PayloadJSON = "{}"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO auth_challenges (challenge_id, purpose, challenge_bytes_hex, account_id, agent_id, payload_json, expires_at_ms, consumed)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)
	`, ch.ChallengeID, ch.Purpose, ch.ChallengeBytesHex, ch.AccountID, ch.AgentID, ch.PayloadJSON, ch.ExpiresAtMs)
	return err
}

func (s *SQLiteStore) ConsumeChallenge(ctx context.Context, challengeID, purpose string, nowMs int64) (*AuthChallenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var ch AuthChallenge
	var consumed int
	err = tx.QueryRowContext(ctx, `
		SELECT challenge_id, purpose, challenge_bytes_hex, account_id, agent_id, payload_json, expires_at_ms, consumed
		FROM auth_challenges WHERE challenge_id = ? AND purpose = ?
	`, challengeID, purpose).Scan(&ch.ChallengeID, &ch.Purpose, &ch.ChallengeBytesHex, &ch.AccountID, &ch.AgentID, &ch.PayloadJSON, &ch.ExpiresAtMs, &consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if consumed != 0 {
		return nil, ErrConflict
	}
	if ch.ExpiresAtMs <= nowMs {
		return nil, ErrExpired
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_challenges SET consumed = 1 WHERE challenge_id = ?`, challengeID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	ch.Consumed = true
	return &ch, nil
}

func (s *SQLiteStore) SavePasskeyCredential(ctx context.Context, cred PasskeyCredential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO passkey_credentials (credential_id, account_id, agent_id, alg, public_key_hex, sign_count, prf_salt_hex, created_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, cred.CredentialID, cred.AccountID, cred.AgentID, cred.Alg, cred.PublicKeyHex, cred.SignCount, cred.PRFSaltHex, cred.CreatedAtMs)
	return err
}

func (s *SQLiteStore) GetPasskeyCredential(ctx context.Context, credentialID string) (*PasskeyCredential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var c PasskeyCredential
	err := s.db.QueryRowContext(ctx, `
		SELECT credential_id, account_id, agent_id, alg, public_key_hex, sign_count, prf_salt_hex, created_at_ms
		FROM passkey_credentials WHERE credential_id = ?
	`, credentialID).Scan(&c.CredentialID, &c.AccountID, &c.AgentID, &c.Alg, &c.PublicKeyHex, &c.SignCount, &c.PRFSaltHex, &c.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *SQLiteStore) ListPasskeyCredentialsByAgent(ctx context.Context, agentID string) ([]PasskeyCredential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT credential_id, account_id, agent_id, alg, public_key_hex, sign_count, prf_salt_hex, created_at_ms
		FROM passkey_credentials WHERE agent_id = ? ORDER BY created_at_ms ASC
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

func (s *SQLiteStore) UpdatePasskeySignCount(ctx context.Context, credentialID string, signCount uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `UPDATE passkey_credentials SET sign_count = ? WHERE credential_id = ?`, signCount, credentialID)
	return err
}

func (s *SQLiteStore) UpsertOpaqueRegistration(ctx context.Context, reg OpaqueRegistration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO opaque_registrations (agent_id, account_id, credential_identifier, client_public_key_hex, masking_key_hex, envelope_hex, oprf_key_scalar_hex, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET
			credential_identifier = excluded.credential_identifier,
			client_public_key_hex = excluded.client_public_key_hex,
			masking_key_hex = excluded.masking_key_hex,
			envelope_hex = excluded.envelope_hex,
			oprf_key_scalar_hex = excluded.oprf_key_scalar_hex,
			updated_at_ms = excluded.updated_at_ms
	`, reg.AgentID, reg.AccountID, reg.CredentialIdentifier, reg.ClientPublicKeyHex, reg.MaskingKeyHex, reg.EnvelopeHex, reg.OPRFKeyScalarHex, reg.UpdatedAtMs)
	return err
}

func (s *SQLiteStore) GetOpaqueRegistration(ctx context.Context, agentID string) (*OpaqueRegistration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var reg OpaqueRegistration
	err := s.db.QueryRowContext(ctx, `
		SELECT agent_id, account_id, credential_identifier, client_public_key_hex, masking_key_hex, envelope_hex, oprf_key_scalar_hex, updated_at_ms
		FROM opaque_registrations WHERE agent_id = ?
	`, agentID).Scan(&reg.AgentID, &reg.AccountID, &reg.CredentialIdentifier, &reg.ClientPublicKeyHex, &reg.MaskingKeyHex, &reg.EnvelopeHex, &reg.OPRFKeyScalarHex, &reg.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &reg, nil
}

func (s *SQLiteStore) SaveOpaqueLoginState(ctx context.Context, st OpaqueLoginState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO opaque_login_states (login_id, agent_id, account_id, device_id, km3_hex, preamble_hex, server_mac_hex, expires_at_ms, consumed)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
	`, st.LoginID, st.AgentID, st.AccountID, st.DeviceID, st.KM3Hex, st.PreambleHex, st.ServerMACHex, st.ExpiresAtMs)
	return err
}

func (s *SQLiteStore) ConsumeOpaqueLoginState(ctx context.Context, loginID string, nowMs int64) (*OpaqueLoginState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var st OpaqueLoginState
	var consumed int
	err = tx.QueryRowContext(ctx, `
		SELECT login_id, agent_id, account_id, device_id, km3_hex, preamble_hex, server_mac_hex, expires_at_ms, consumed
		FROM opaque_login_states WHERE login_id = ?
	`, loginID).Scan(&st.LoginID, &st.AgentID, &st.AccountID, &st.DeviceID, &st.KM3Hex, &st.PreambleHex, &st.ServerMACHex, &st.ExpiresAtMs, &consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if consumed != 0 {
		return nil, ErrConflict
	}
	if st.ExpiresAtMs <= nowMs {
		return nil, ErrExpired
	}
	if _, err := tx.ExecContext(ctx, `UPDATE opaque_login_states SET consumed = 1 WHERE login_id = ?`, loginID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	st.Consumed = true
	return &st, nil
}

func (s *SQLiteStore) CreatePairingSession(ctx context.Context, ps PairingSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pairing_sessions (pairing_id, short_code_hmac_hex, agent_id, initiator_account_id, max_attempts, expires_at_ms)
		VALUES (?, ?, ?, ?, ?, ?)
	`, ps.PairingID, ps.ShortCodeHMACHex, ps.AgentID, ps.InitiatorAccountID, ps.MaxAttempts, ps.ExpiresAtMs)
	return err
}

func scanPairingSession(row interface{ Scan(...any) error }) (*PairingSession, error) {
	var ps PairingSession
	var locked, consumed int
	err := row.Scan(
		&ps.PairingID, &ps.ShortCodeHMACHex, &ps.AgentID, &ps.InitiatorAccountID,
		&ps.NewDeviceID, &ps.NewDeviceEd25519Hex, &ps.NewDeviceXWingPKHex,
		&ps.HPKEEncHex, &ps.CiphertextHex, &ps.AADUTF8,
		&ps.FailedAttempts, &ps.MaxAttempts, &locked, &consumed, &ps.ExpiresAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	ps.Locked = locked != 0
	ps.Consumed = consumed != 0
	return &ps, nil
}

func (s *SQLiteStore) GetPairingSession(ctx context.Context, pairingID string) (*PairingSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRowContext(ctx, `
		SELECT pairing_id, short_code_hmac_hex, agent_id, initiator_account_id,
		       new_device_id, new_device_ed25519_hex, new_device_xwing_pk_hex,
		       hpke_enc_hex, ciphertext_hex, aad_utf8,
		       failed_attempts, max_attempts, locked, consumed, expires_at_ms
		FROM pairing_sessions WHERE pairing_id = ?
	`, pairingID)
	return scanPairingSession(row)
}

func (s *SQLiteStore) RecordPairingAttempt(ctx context.Context, pairingID, expectedShortCodeHMACHex, providedHMACHex string, nowMs int64) (*PairingSession, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
		SELECT pairing_id, short_code_hmac_hex, agent_id, initiator_account_id,
		       new_device_id, new_device_ed25519_hex, new_device_xwing_pk_hex,
		       hpke_enc_hex, ciphertext_hex, aad_utf8,
		       failed_attempts, max_attempts, locked, consumed, expires_at_ms
		FROM pairing_sessions WHERE pairing_id = ?
	`, pairingID)
	ps, err := scanPairingSession(row)
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
		if _, err := tx.ExecContext(ctx,
			`UPDATE pairing_sessions SET failed_attempts = ?, locked = ? WHERE pairing_id = ?`,
			ps.FailedAttempts, boolToInt(ps.Locked), pairingID,
		); err != nil {
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

func (s *SQLiteStore) UpdatePairingJoiner(ctx context.Context, pairingID, newDevID, newEdHex, newXWingHex string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `
		UPDATE pairing_sessions
		SET new_device_id = ?, new_device_ed25519_hex = ?, new_device_xwing_pk_hex = ?
		WHERE pairing_id = ? AND locked = 0 AND consumed = 0 AND new_device_id = '' AND ciphertext_hex = ''
	`, newDevID, newEdHex, newXWingHex, pairingID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return nil
}

func (s *SQLiteStore) ApprovePairingSession(ctx context.Context, pairingID, hpkeEncHex, ciphertextHex, aadUTF8 string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `
		UPDATE pairing_sessions
		SET hpke_enc_hex = ?, ciphertext_hex = ?, aad_utf8 = ?
		WHERE pairing_id = ? AND locked = 0 AND consumed = 0 AND new_device_id != '' AND ciphertext_hex = ''
	`, hpkeEncHex, ciphertextHex, aadUTF8, pairingID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return nil
}

func (s *SQLiteStore) ConsumePairingSession(ctx context.Context, pairingID string, nowMs int64) (*PairingSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, `
		SELECT pairing_id, short_code_hmac_hex, agent_id, initiator_account_id,
		       new_device_id, new_device_ed25519_hex, new_device_xwing_pk_hex,
		       hpke_enc_hex, ciphertext_hex, aad_utf8,
		       failed_attempts, max_attempts, locked, consumed, expires_at_ms
		FROM pairing_sessions WHERE pairing_id = ?
	`, pairingID)
	ps, err := scanPairingSession(row)
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
	if _, err := tx.ExecContext(ctx, `UPDATE pairing_sessions SET consumed = 1 WHERE pairing_id = ?`, pairingID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	ps.Consumed = true
	return ps, nil
}

func (s *SQLiteStore) SaveGuardianSetup(ctx context.Context, cfg GuardianConfig, shares []GuardianShareCustody) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO guardian_configs (agent_id, threshold, total, commitment_blake3_hex, updated_at_ms)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET
			threshold = excluded.threshold,
			total = excluded.total,
			commitment_blake3_hex = excluded.commitment_blake3_hex,
			updated_at_ms = excluded.updated_at_ms
	`, cfg.AgentID, cfg.Threshold, cfg.Total, cfg.CommitmentBlake3Hex, cfg.UpdatedAtMs); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM guardian_shares WHERE agent_id = ?`, cfg.AgentID); err != nil {
		return err
	}
	for _, sh := range shares {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO guardian_shares (agent_id, share_index, guardian_id, guardian_pubkey_hex, encrypted_share_hex, hpke_enc_hex, aad_utf8)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`, cfg.AgentID, sh.ShareIndex, sh.GuardianID, sh.GuardianPubKeyHex, sh.EncryptedShareHex, sh.HPKEEncHex, sh.AADUTF8); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLiteStore) GetGuardianSetup(ctx context.Context, agentID string) (*GuardianConfig, []GuardianShareCustody, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var cfg GuardianConfig
	err := s.db.QueryRowContext(ctx, `
		SELECT agent_id, threshold, total, commitment_blake3_hex, updated_at_ms
		FROM guardian_configs WHERE agent_id = ?
	`, agentID).Scan(&cfg.AgentID, &cfg.Threshold, &cfg.Total, &cfg.CommitmentBlake3Hex, &cfg.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT agent_id, share_index, guardian_id, guardian_pubkey_hex, encrypted_share_hex, hpke_enc_hex, aad_utf8
		FROM guardian_shares WHERE agent_id = ? ORDER BY share_index ASC
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

func (s *SQLiteStore) CreateGuardianRecovery(ctx context.Context, rec GuardianRecovery) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO guardian_recoveries (recovery_id, agent_id, requester_xwing_pk_hex, expires_at_ms, created_at_ms)
		VALUES (?, ?, ?, ?, ?)
	`, rec.RecoveryID, rec.AgentID, rec.RequesterXWingPKHex, rec.ExpiresAtMs, rec.CreatedAtMs)
	return err
}

func (s *SQLiteStore) GetGuardianRecovery(ctx context.Context, recoveryID string) (*GuardianRecovery, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rec GuardianRecovery
	err := s.db.QueryRowContext(ctx, `
		SELECT recovery_id, agent_id, requester_xwing_pk_hex, expires_at_ms, created_at_ms
		FROM guardian_recoveries WHERE recovery_id = ?
	`, recoveryID).Scan(&rec.RecoveryID, &rec.AgentID, &rec.RequesterXWingPKHex, &rec.ExpiresAtMs, &rec.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *SQLiteStore) AddGuardianApproval(ctx context.Context, app GuardianApproval) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO guardian_approvals (recovery_id, share_index, guardian_id, signature_hex, rewrapped_share_hex, rewrapped_hpke_enc_hex, approved_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(recovery_id, share_index) DO UPDATE SET
			signature_hex = excluded.signature_hex,
			rewrapped_share_hex = excluded.rewrapped_share_hex,
			rewrapped_hpke_enc_hex = excluded.rewrapped_hpke_enc_hex,
			approved_at_ms = excluded.approved_at_ms
	`, app.RecoveryID, app.ShareIndex, app.GuardianID, app.SignatureHex, app.RewrappedShareHex, app.RewrappedHPKEEncHex, app.ApprovedAtMs)
	return err
}

func (s *SQLiteStore) ListGuardianApprovals(ctx context.Context, recoveryID string) ([]GuardianApproval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT recovery_id, share_index, guardian_id, signature_hex, rewrapped_share_hex, rewrapped_hpke_enc_hex, approved_at_ms
		FROM guardian_approvals WHERE recovery_id = ? ORDER BY share_index ASC
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

func (s *SQLiteStore) CreatePackUpload(ctx context.Context, up PackUpload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pack_uploads (upload_id, agent_id, pack_id, content_length, sha256_hex, blob_key, uploaded, committed, expires_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
	`, up.UploadID, up.AgentID, up.PackID, up.ContentLength, up.SHA256Hex, up.BlobKey, up.ExpiresAtMs)
	return err
}

func (s *SQLiteStore) GetPackUpload(ctx context.Context, uploadID string) (*PackUpload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var up PackUpload
	var uploaded, committed int
	err := s.db.QueryRowContext(ctx, `
		SELECT upload_id, agent_id, pack_id, content_length, sha256_hex, blob_key, uploaded, committed, expires_at_ms
		FROM pack_uploads WHERE upload_id = ?
	`, uploadID).Scan(&up.UploadID, &up.AgentID, &up.PackID, &up.ContentLength, &up.SHA256Hex, &up.BlobKey, &uploaded, &committed, &up.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	up.Uploaded = uploaded != 0
	up.Committed = committed != 0
	return &up, nil
}

func (s *SQLiteStore) MarkPackUploaded(ctx context.Context, uploadID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `UPDATE pack_uploads SET uploaded = 1 WHERE upload_id = ?`, uploadID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) CommitSpinePack(ctx context.Context, uploadID string, rec SpinePackRecord) (*SpinePackRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// Idempotent check by (agent_id, pack_id)
	var existing SpinePackRecord
	err = tx.QueryRowContext(ctx, `
		SELECT agent_id, server_seq, pack_id, device_id, compartment, epoch, first_seq, last_seq,
		       min_hlc_hex, max_hlc_hex, padded_len, uncompressed_blake3_hex, aad_utf8,
		       dek_wrap_nonce_hex, wrapped_dek_hex, pack_nonce_hex, content_length, sha256_hex, blob_key, created_at_ms
		FROM spine_packs WHERE agent_id = ? AND pack_id = ?
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
	var uploaded, committed int
	err = tx.QueryRowContext(ctx, `
		SELECT upload_id, agent_id, pack_id, content_length, sha256_hex, blob_key, uploaded, committed, expires_at_ms
		FROM pack_uploads WHERE upload_id = ?
	`, uploadID).Scan(&up.UploadID, &up.AgentID, &up.PackID, &up.ContentLength, &up.SHA256Hex, &up.BlobKey, &uploaded, &committed, &up.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if uploaded == 0 || up.AgentID != rec.AgentID || up.PackID != rec.PackID || up.ContentLength != rec.ContentLength || up.SHA256Hex != rec.SHA256Hex {
		return nil, ErrConflict
	}

	var quotaBytes, usedBytes int64
	if err := tx.QueryRowContext(ctx, `SELECT quota_bytes, used_bytes FROM agents WHERE agent_id = ?`, rec.AgentID).Scan(&quotaBytes, &usedBytes); err != nil {
		return nil, err
	}
	if usedBytes+rec.ContentLength > quotaBytes {
		return nil, ErrQuotaExceeded
	}

	var maxSeq uint64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(server_seq), 0) FROM spine_packs WHERE agent_id = ?`, rec.AgentID).Scan(&maxSeq); err != nil {
		return nil, err
	}
	rec.ServerSeq = maxSeq + 1
	rec.BlobKey = up.BlobKey

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO spine_packs (
			agent_id, server_seq, pack_id, device_id, compartment, epoch, first_seq, last_seq,
			min_hlc_hex, max_hlc_hex, padded_len, uncompressed_blake3_hex, aad_utf8,
			dek_wrap_nonce_hex, wrapped_dek_hex, pack_nonce_hex, content_length, sha256_hex, blob_key, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		rec.AgentID, rec.ServerSeq, rec.PackID, rec.DeviceID, rec.Compartment, rec.Epoch, rec.FirstSeq, rec.LastSeq,
		rec.MinHLCHex, rec.MaxHLCHex, rec.PaddedLen, rec.UncompressedBlake3Hex, rec.AADUTF8,
		rec.DEKWrapNonceHex, rec.WrappedDEKHex, rec.PackNonceHex, rec.ContentLength, rec.SHA256Hex, rec.BlobKey, rec.CreatedAtMs,
	); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agents SET used_bytes = used_bytes + ? WHERE agent_id = ?`, rec.ContentLength, rec.AgentID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE pack_uploads SET committed = 1 WHERE upload_id = ?`, uploadID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *SQLiteStore) ListSpinePacks(ctx context.Context, agentID string, afterSeq uint64, limit uint32) ([]SpinePackRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit == 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT agent_id, server_seq, pack_id, device_id, compartment, epoch, first_seq, last_seq,
		       min_hlc_hex, max_hlc_hex, padded_len, uncompressed_blake3_hex, aad_utf8,
		       dek_wrap_nonce_hex, wrapped_dek_hex, pack_nonce_hex, content_length, sha256_hex, blob_key, created_at_ms
		FROM spine_packs
		WHERE agent_id = ? AND server_seq > ?
		ORDER BY server_seq ASC
		LIMIT ?
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

func (s *SQLiteStore) AcquireLease(ctx context.Context, agentID, deviceID string, expectedEpoch uint64, ttlMs, nowMs int64) (*LeaseRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur LeaseRecord
	err = tx.QueryRowContext(ctx, `
		SELECT agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
		FROM leases WHERE agent_id = ?
	`, agentID).Scan(&cur.AgentID, &cur.HolderDeviceID, &cur.WitnessEpoch, &cur.ExpiresAtMs, &cur.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		if expectedEpoch > 0 {
			return nil, &StaleLeaseError{Provided: expectedEpoch, Current: 0}
		}
		rec := LeaseRecord{
			AgentID:        agentID,
			HolderDeviceID: deviceID,
			WitnessEpoch:   1,
			ExpiresAtMs:    nowMs + ttlMs,
			UpdatedAtMs:    nowMs,
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO leases (agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms)
			VALUES (?, ?, ?, ?, ?)
		`, rec.AgentID, rec.HolderDeviceID, rec.WitnessEpoch, rec.ExpiresAtMs, rec.UpdatedAtMs); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return &rec, nil
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
		cur.ExpiresAtMs = nowMs + ttlMs
		cur.UpdatedAtMs = nowMs
		if _, err := tx.ExecContext(ctx, `
			UPDATE leases SET expires_at_ms = ?, updated_at_ms = ? WHERE agent_id = ? AND witness_epoch = ?
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
		ExpiresAtMs:    nowMs + ttlMs,
		UpdatedAtMs:    nowMs,
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE leases
		SET holder_device_id = ?, witness_epoch = ?, expires_at_ms = ?, updated_at_ms = ?
		WHERE agent_id = ? AND witness_epoch = ?
	`, next.HolderDeviceID, next.WitnessEpoch, next.ExpiresAtMs, next.UpdatedAtMs, agentID, cur.WitnessEpoch); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &next, nil
}

func (s *SQLiteStore) RenewLease(ctx context.Context, agentID, deviceID string, witnessEpoch uint64, ttlMs, nowMs int64) (*LeaseRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur LeaseRecord
	err = tx.QueryRowContext(ctx, `
		SELECT agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
		FROM leases WHERE agent_id = ?
	`, agentID).Scan(&cur.AgentID, &cur.HolderDeviceID, &cur.WitnessEpoch, &cur.ExpiresAtMs, &cur.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &StaleLeaseError{Provided: witnessEpoch, Current: 0}
	}
	if err != nil {
		return nil, err
	}
	if cur.WitnessEpoch != witnessEpoch || cur.HolderDeviceID != deviceID || cur.ExpiresAtMs <= nowMs {
		return nil, &StaleLeaseError{Provided: witnessEpoch, Current: cur.WitnessEpoch, Holder: cur.HolderDeviceID}
	}
	cur.ExpiresAtMs = nowMs + ttlMs
	cur.UpdatedAtMs = nowMs
	if _, err := tx.ExecContext(ctx, `
		UPDATE leases SET expires_at_ms = ?, updated_at_ms = ?
		WHERE agent_id = ? AND holder_device_id = ? AND witness_epoch = ?
	`, cur.ExpiresAtMs, cur.UpdatedAtMs, agentID, deviceID, witnessEpoch); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &cur, nil
}

func (s *SQLiteStore) ReleaseLease(ctx context.Context, agentID, deviceID string, witnessEpoch uint64, nowMs int64) (*LeaseRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur LeaseRecord
	err = tx.QueryRowContext(ctx, `
		SELECT agent_id, holder_device_id, witness_epoch, expires_at_ms, updated_at_ms
		FROM leases WHERE agent_id = ?
	`, agentID).Scan(&cur.AgentID, &cur.HolderDeviceID, &cur.WitnessEpoch, &cur.ExpiresAtMs, &cur.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &StaleLeaseError{Provided: witnessEpoch, Current: 0}
	}
	if err != nil {
		return nil, err
	}
	if cur.WitnessEpoch != witnessEpoch || cur.HolderDeviceID != deviceID {
		return nil, &StaleLeaseError{Provided: witnessEpoch, Current: cur.WitnessEpoch, Holder: cur.HolderDeviceID}
	}
	cur.HolderDeviceID = ""
	cur.ExpiresAtMs = nowMs
	cur.UpdatedAtMs = nowMs
	if _, err := tx.ExecContext(ctx, `
		UPDATE leases SET holder_device_id = '', expires_at_ms = ?, updated_at_ms = ?
		WHERE agent_id = ? AND witness_epoch = ?
	`, nowMs, nowMs, agentID, witnessEpoch); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &cur, nil
}

// CreateGroupRoom 创建零知识群房间元数据。
func (s *SQLiteStore) CreateGroupRoom(ctx context.Context, room GroupRoom) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO group_rooms (group_id, owner_agent_id, secrecy_level, current_mls_epoch, created_at_ms)
		VALUES (?, ?, ?, ?, ?)
	`, room.GroupID, room.OwnerAgentID, room.SecrecyLevel, room.CurrentMLSEpoch, room.CreatedAtMs)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return ErrConflict
		}
		return err
	}
	return nil
}

// GetGroupRoom 返回群房间元数据；不存在时返回 ErrNotFound。
func (s *SQLiteStore) GetGroupRoom(ctx context.Context, groupID string) (*GroupRoom, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var room GroupRoom
	err := s.db.QueryRowContext(ctx, `
		SELECT group_id, owner_agent_id, secrecy_level, current_mls_epoch, created_at_ms
		FROM group_rooms WHERE group_id = ?
	`, groupID).Scan(&room.GroupID, &room.OwnerAgentID, &room.SecrecyLevel, &room.CurrentMLSEpoch, &room.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &room, nil
}

// ListGroupRooms 列出全部群房间元数据。
func (s *SQLiteStore) ListGroupRooms(ctx context.Context) ([]GroupRoom, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
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

// AddGroupMember 幂等地写入群成员关系。
func (s *SQLiteStore) AddGroupMember(ctx context.Context, member GroupMember) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO group_members (group_id, agent_id, role, added_at_ms)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(group_id, agent_id) DO UPDATE SET role = excluded.role
	`, member.GroupID, member.AgentID, member.Role, member.AddedAtMs)
	return err
}

// GetGroupMember 返回指定成员关系；不存在时返回 ErrNotFound。
func (s *SQLiteStore) GetGroupMember(ctx context.Context, groupID, agentID string) (*GroupMember, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var member GroupMember
	err := s.db.QueryRowContext(ctx, `
		SELECT group_id, agent_id, role, added_at_ms
		FROM group_members WHERE group_id = ? AND agent_id = ?
	`, groupID, agentID).Scan(&member.GroupID, &member.AgentID, &member.Role, &member.AddedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &member, nil
}

// ListGroupMembers 列出群内全部成员。
func (s *SQLiteStore) ListGroupMembers(ctx context.Context, groupID string) ([]GroupMember, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT group_id, agent_id, role, added_at_ms
		FROM group_members WHERE group_id = ? ORDER BY added_at_ms ASC, agent_id ASC
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

// AppendGroupCommit 在单事务内为该群原子分配严格单调的 server_seq，
// 并在同一事务中校验/推进 MLS 纪元（避免陈旧纪元并发穿透）。
func (s *SQLiteStore) AppendGroupCommit(ctx context.Context, commit GroupCommit) (*GroupCommit, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var currentEpoch uint64
	if err := tx.QueryRowContext(ctx, `
		SELECT current_mls_epoch FROM group_rooms WHERE group_id = ?
	`, commit.GroupID).Scan(&currentEpoch); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := validateEpochAdvance(currentEpoch, commit); err != nil {
		return nil, err
	}

	var nextSeq uint64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) + 1 FROM group_commits WHERE group_id = ?
	`, commit.GroupID).Scan(&nextSeq); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO group_commits (
			group_id, server_seq, mls_epoch, causal_parent_seq, sender_agent_id,
			sender_device_id, mentions_json, ciphertext_b64, kind, author_kind, hop, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, commit.GroupID, nextSeq, commit.MLSEpoch, commit.CausalParentSeq, commit.SenderAgentID,
		commit.SenderDeviceID, commit.MentionsJSON, commit.CiphertextB64, commit.Kind,
		commit.AuthorKind, commit.Hop, commit.CreatedAtMs); err != nil {
		return nil, err
	}
	if commit.MLSEpoch > currentEpoch {
		if _, err := tx.ExecContext(ctx, `
			UPDATE group_rooms SET current_mls_epoch = ? WHERE group_id = ?
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

// ListGroupCommits 按 server_seq 升序返回水位线之后的密文提交。
func (s *SQLiteStore) ListGroupCommits(ctx context.Context, groupID string, afterSeq uint64, limit int) ([]GroupCommit, error) {
	if limit <= 0 {
		limit = 200
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT group_id, server_seq, mls_epoch, causal_parent_seq, sender_agent_id,
		       sender_device_id, mentions_json, ciphertext_b64, kind, author_kind, hop, created_at_ms
		FROM group_commits
		WHERE group_id = ? AND server_seq > ?
		ORDER BY server_seq ASC
		LIMIT ?
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

// DeleteGroupMember 删除群成员关系，立即撤销其提交权限。
func (s *SQLiteStore) DeleteGroupMember(ctx context.Context, groupID, agentID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id = ? AND agent_id = ?`, groupID, agentID)
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

// GetGroupCommit 读取单条密文提交（用于服务端派生跳数）。
func (s *SQLiteStore) GetGroupCommit(ctx context.Context, groupID string, serverSeq uint64) (*GroupCommit, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var commit GroupCommit
	err := s.db.QueryRowContext(ctx, `
		SELECT group_id, server_seq, mls_epoch, causal_parent_seq, sender_agent_id,
		       sender_device_id, mentions_json, ciphertext_b64, kind, author_kind, hop, created_at_ms
		FROM group_commits WHERE group_id = ? AND server_seq = ?
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

// GroupRoomHead 返回真实 MAX(server_seq) 与群当前 MLS 纪元（不受分页截断影响）。
func (s *SQLiteStore) GroupRoomHead(ctx context.Context, groupID string) (uint64, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var head uint64
	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(server_seq), 0) FROM group_commits WHERE group_id = ?
	`, groupID).Scan(&head); err != nil {
		return 0, 0, err
	}
	var epoch uint64
	err := s.db.QueryRowContext(ctx, `SELECT current_mls_epoch FROM group_rooms WHERE group_id = ?`, groupID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, ErrNotFound
	}
	if err != nil {
		return 0, 0, err
	}
	return head, epoch, nil
}

// DBForTest 暴露底层 *sql.DB 供同包外测试执行只读 schema/canary 校验。
// 生产代码严禁使用该访问器。
func (s *SQLiteStore) DBForTest() *sql.DB {
	return s.db
}

// EnqueueWebhookIngress 原子入队一条零知识 Webhook 密文。
// 返回 inserted=false 表示同一 (agent_id, channel, event_id_hash) 已存在（幂等去重）。
func (s *SQLiteStore) EnqueueWebhookIngress(ctx context.Context, rec WebhookIngressRecord, maxPerAgent int) (bool, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback() }()

	var existing int64
	err = tx.QueryRowContext(ctx, `
		SELECT ingress_id FROM webhook_ingress_queue
		WHERE agent_id = ? AND channel = ? AND event_id_hash = ? AND target_device_id = ?
	`, rec.AgentID, rec.Channel, rec.EventIDHash, rec.TargetDeviceID).Scan(&existing)
	if err == nil {
		var depth int
		if countErr := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = ?`, rec.AgentID).Scan(&depth); countErr != nil {
			return false, 0, countErr
		}
		return false, depth, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, 0, err
	}

	var depth int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = ?`, rec.AgentID).Scan(&depth); err != nil {
		return false, 0, err
	}
	var sameEvent int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = ? AND channel = ? AND event_id_hash = ?`, rec.AgentID, rec.Channel, rec.EventIDHash).Scan(&sameEvent); err != nil {
		return false, 0, err
	}
	if maxPerAgent > 0 && depth >= maxPerAgent && sameEvent == 0 {
		return false, depth, ErrQuotaExceeded
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO webhook_ingress_queue (
			agent_id, channel, event_id_hash, target_device_id, hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, rec.AgentID, rec.Channel, rec.EventIDHash, rec.TargetDeviceID, rec.HPKEEncHex, rec.CiphertextHex, rec.AADUTF8, rec.ReceivedAtMs, rec.CreatedAtMs); err != nil {
		return false, 0, err
	}
	if err := tx.Commit(); err != nil {
		return false, 0, err
	}
	return true, depth + 1, nil
}

// ListWebhookIngress 按入队顺序读取某 Agent 的待解密密文行。
func (s *SQLiteStore) ListWebhookIngress(ctx context.Context, agentID, deviceID string, after int64, limit int) ([]WebhookIngressRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT ingress_id, agent_id, channel, event_id_hash, target_device_id, hpke_enc_hex, ciphertext_hex, aad_utf8, received_at_ms, created_at_ms
		FROM webhook_ingress_queue WHERE agent_id = ? AND (? = '' OR target_device_id = ? OR target_device_id = '')
		AND ingress_id > ? ORDER BY ingress_id ASC LIMIT ?
	`, agentID, deviceID, deviceID, after, limit)
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

// DeleteWebhookIngress 在本地成功解密消费后删除该行。
func (s *SQLiteStore) DeleteWebhookIngress(ctx context.Context, agentID string, ingressID int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = ? AND ingress_id = ?`, agentID, ingressID)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

// CountWebhookIngress 返回某 Agent 的待解密密文队列深度。
func (s *SQLiteStore) CountWebhookIngress(ctx context.Context, agentID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var depth int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = ?`, agentID).Scan(&depth); err != nil {
		return 0, err
	}
	return depth, nil
}

// WebhookIngressKey 是带通道隔离的确认键，防止跨通道误删同一 event id。
type WebhookIngressKey struct {
	Channel        string
	EventIDHash    string
	TargetDeviceID string
}

// DeleteWebhookIngressByKeys 仅删除调用者 Agent 拥有的 (channel, event_id_hash) 行。
func (s *SQLiteStore) DeleteWebhookIngressByKeys(ctx context.Context, agentID string, keys []WebhookIngressKey) (int64, error) {
	if len(keys) == 0 {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var deleted int64
	for _, key := range keys {
		res, err := tx.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = ? AND channel = ? AND event_id_hash = ? AND (target_device_id = ? OR target_device_id = '')`, agentID, key.Channel, key.EventIDHash, key.TargetDeviceID)
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

// DeleteWebhookIngressForDevice 在设备入站密钥轮换时丢弃该设备旧公钥封装的待取行（ack-and-audit）。
func (s *SQLiteStore) DeleteWebhookIngressForDevice(ctx context.Context, agentID, deviceID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = ? AND target_device_id = ?`, agentID, deviceID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// CountWebhookIngressEvents 按事件计数（同事件多设备副本只算一个）。
func (s *SQLiteStore) CountWebhookIngressEvents(ctx context.Context, agentID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM (SELECT DISTINCT channel, event_id_hash FROM webhook_ingress_queue WHERE agent_id = ?)`, agentID).Scan(&count)
	return count, err
}

// WebhookIngressEventExists 判断同一事件是否已为任一设备入队（幂等重投递）。
func (s *SQLiteStore) WebhookIngressEventExists(ctx context.Context, agentID, channel, eventIDHash string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue WHERE agent_id = ? AND channel = ? AND event_id_hash = ?`, agentID, channel, eventIDHash).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// DeleteWebhookIngressEvent 用于多设备批量密封失败时的事务性回滚。
func (s *SQLiteStore) DeleteWebhookIngressEvent(ctx context.Context, agentID, channel, eventIDHash string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM webhook_ingress_queue WHERE agent_id = ? AND channel = ? AND event_id_hash = ?`, agentID, channel, eventIDHash)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

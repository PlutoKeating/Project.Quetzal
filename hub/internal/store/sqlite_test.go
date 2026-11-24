// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// legacyGroupSchemaDDL 复刻 Fix Round 1 之前的群组表结构，用于验证旧数据目录的幂等迁移。
const legacyGroupSchemaDDL = `
CREATE TABLE IF NOT EXISTS agents (
	agent_id TEXT PRIMARY KEY,
	owner_account_id TEXT NOT NULL,
	root_verifying_key_hex TEXT NOT NULL,
	quota_bytes INTEGER NOT NULL,
	used_bytes INTEGER NOT NULL DEFAULT 0,
	created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_rooms (
	group_id TEXT PRIMARY KEY,
	owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
	secrecy_level INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL
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
	created_at_ms INTEGER NOT NULL,
	PRIMARY KEY (group_id, server_seq)
);
`

// seedLegacySQLiteDB 写出一个 Fix Round 1 之前的旧数据目录（含一条既有房间）。
func seedLegacySQLiteDB(t *testing.T, dbPath string) {
	t.Helper()
	raw, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open legacy sqlite: %v", err)
	}
	defer func() { _ = raw.Close() }()
	if _, err := raw.Exec(legacyGroupSchemaDDL); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	if _, err := raw.Exec(`
		INSERT INTO agents (agent_id, owner_account_id, root_verifying_key_hex, quota_bytes, created_at_ms)
		VALUES ('agent-a', 'acct-a', '00', 1048576, 1)
	`); err != nil {
		t.Fatalf("seed legacy agent: %v", err)
	}
	if _, err := raw.Exec(`
		INSERT INTO group_rooms (group_id, owner_agent_id, secrecy_level, created_at_ms)
		VALUES ('legacy-room', 'agent-a', 1, 1)
	`); err != nil {
		t.Fatalf("seed legacy room: %v", err)
	}
}

func TestSQLiteStoreMigratesLegacyGroupSchemaInPlace(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "hub.sqlite")
	seedLegacySQLiteDB(t, dbPath)

	st, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteStore on legacy dir: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// 旧房间必须可被读取，且新纪元列已补齐为 0。
	room, err := st.GetGroupRoom(context.Background(), "legacy-room")
	if err != nil {
		t.Fatalf("GetGroupRoom after migration: %v", err)
	}
	if room.CurrentMLSEpoch != 0 {
		t.Fatalf("migrated room epoch must default to 0, got %d", room.CurrentMLSEpoch)
	}

	// 旧库上的追加必须成功并写回新列。
	stored, err := st.AppendGroupCommit(context.Background(), GroupCommit{
		GroupID:         "legacy-room",
		MLSEpoch:        0,
		CausalParentSeq: 0,
		SenderAgentID:   "agent-a",
		SenderDeviceID:  "dev-a",
		MentionsJSON:    "[]",
		CiphertextB64:   "b3BhcXVl",
		Kind:            "constraint_update",
		AuthorKind:      "agent",
		Hop:             1,
		CreatedAtMs:     2,
	})
	if err != nil {
		t.Fatalf("append on migrated legacy dir: %v", err)
	}
	if stored.ServerSeq != 1 {
		t.Fatalf("first legacy append must be seq 1, got %d", stored.ServerSeq)
	}

	listed, err := st.ListGroupCommits(context.Background(), "legacy-room", 0, 10)
	if err != nil {
		t.Fatalf("list on migrated legacy dir: %v", err)
	}
	if len(listed) != 1 || listed[0].Kind != "constraint_update" || listed[0].AuthorKind != "agent" || listed[0].Hop != 1 {
		t.Fatalf("migrated columns did not round-trip: %+v", listed)
	}

	// 迁移出的 current_mls_epoch 列必须参与原子纪元推进（恰 +1 的纯密钥轮换）。
	if _, err := st.AppendGroupCommit(context.Background(), GroupCommit{
		GroupID:         "legacy-room",
		MLSEpoch:        1,
		CausalParentSeq: 1,
		SenderAgentID:   "agent-a",
		SenderDeviceID:  "dev-a",
		MentionsJSON:    "[]",
		CiphertextB64:   "cm90YXRlZA==",
		Kind:            "message",
		AuthorKind:      "human",
		CreatedAtMs:     3,
		ReencryptOnly:   true,
	}); err != nil {
		t.Fatalf("epoch rotation on migrated legacy dir: %v", err)
	}
	if _, err := st.AppendGroupCommit(context.Background(), GroupCommit{
		GroupID:         "legacy-room",
		MLSEpoch:        1,
		CausalParentSeq: 2,
		SenderAgentID:   "agent-a",
		SenderDeviceID:  "dev-a",
		MentionsJSON:    "[]",
		CiphertextB64:   "c3RhbGU=",
		Kind:            "message",
		AuthorKind:      "human",
		CreatedAtMs:     4,
	}); err != nil {
		t.Fatalf("equal-epoch append after rotation: %v", err)
	}

	// 迁移必须幂等：再次打开同一数据目录不报错且不丢数据。
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	reopened, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("re-open migrated dir: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	head, epoch, err := reopened.GroupRoomHead(context.Background(), "legacy-room")
	if err != nil {
		t.Fatalf("head after reopen: %v", err)
	}
	if head != 3 || epoch != 1 {
		t.Fatalf("unexpected head/epoch after reopen: %d/%d", head, epoch)
	}
}

// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func commitTestPack(t *testing.T, st Store, agentID, packID string, size int64) {
	t.Helper()
	ctx := context.Background()
	uploadID := "upload-" + packID
	sha := fmt.Sprintf("%064x", size)
	if err := st.CreatePackUpload(ctx, PackUpload{
		UploadID: uploadID, AgentID: agentID, PackID: packID,
		ContentLength: size, SHA256Hex: sha, BlobKey: "blob/" + packID, ExpiresAtMs: math.MaxInt64,
	}); err != nil {
		t.Fatalf("create upload %s: %v", packID, err)
	}
	if err := st.MarkPackUploaded(ctx, uploadID); err != nil {
		t.Fatalf("mark uploaded %s: %v", packID, err)
	}
	if _, err := st.CommitSpinePack(ctx, uploadID, SpinePackRecord{
		AgentID: agentID, PackID: packID, DeviceID: "dev", ContentLength: size, SHA256Hex: sha, AADUTF8: "{}",
	}); err != nil {
		t.Fatalf("commit pack %s: %v", packID, err)
	}
}

func mustTotals(t *testing.T, st Store, nowMs int64) Totals {
	t.Helper()
	totals, err := st.Totals(context.Background(), nowMs)
	if err != nil {
		t.Fatalf("Totals: %v", err)
	}
	return totals
}

// exerciseTotals 以「前后差值」断言聚合，因此同一套断言既能跑全新的 SQLite，
// 也能跑可能已有其它数据的 PostgreSQL 测试库。
func exerciseTotals(t *testing.T, st Store, suffix string) {
	t.Helper()
	ctx := context.Background()
	acctA, acctB := "acct-a-"+suffix, "acct-b-"+suffix
	roomy, tight, unlimited := "agent-roomy-"+suffix, "agent-tight-"+suffix, "agent-unlimited-"+suffix

	before := mustTotals(t, st, 1_500)

	for _, acct := range []string{acctA, acctB} {
		if err := st.CreateAccount(ctx, Account{AccountID: acct, CreatedAtMs: 1}); err != nil {
			t.Fatalf("create account: %v", err)
		}
	}
	for _, agent := range []Agent{
		{AgentID: roomy, OwnerAccountID: acctA, RootVerifyingKeyHex: "00", QuotaBytes: 1000, CreatedAtMs: 1},
		{AgentID: tight, OwnerAccountID: acctA, RootVerifyingKeyHex: "00", QuotaBytes: 1000, CreatedAtMs: 1},
		// 极大配额不得让字节合计溢出，也不得被算成「快满了」。
		{AgentID: unlimited, OwnerAccountID: acctB, RootVerifyingKeyHex: "00", QuotaBytes: math.MaxInt64, CreatedAtMs: 1},
	} {
		if err := st.CreateAgent(ctx, agent); err != nil {
			t.Fatalf("create agent: %v", err)
		}
	}
	for i := 0; i < 3; i++ {
		commitTestPack(t, st, roomy, fmt.Sprintf("roomy-%d-%s", i, suffix), 100)
	}
	commitTestPack(t, st, tight, "tight-0-"+suffix, 950)

	if _, err := st.AcquireLease(ctx, roomy, "dev", 0, 60_000, 1_000); err != nil {
		t.Fatalf("acquire long lease: %v", err)
	}
	if _, err := st.AcquireLease(ctx, tight, "dev", 0, 1_000, 1_000); err != nil {
		t.Fatalf("acquire short lease: %v", err)
	}
	if _, err := st.EnqueueWebhookIngressBatch(ctx, roomy, "webhook", "event-"+suffix, []WebhookIngressRow{
		{TargetDeviceID: "dev-a", HPKEEncHex: "aa", CiphertextHex: "bb", AADUTF8: "{}", ReceivedAtMs: 1, CreatedAtMs: 1},
		{TargetDeviceID: "dev-b", HPKEEncHex: "cc", CiphertextHex: "dd", AADUTF8: "{}", ReceivedAtMs: 1, CreatedAtMs: 1},
	}, 16); err != nil {
		t.Fatalf("enqueue webhook rows: %v", err)
	}

	seeded := mustTotals(t, st, 1_500)
	if got := seeded.Accounts - before.Accounts; got != 2 {
		t.Fatalf("accounts delta = %d, want 2", got)
	}
	if got := seeded.Agents - before.Agents; got != 3 {
		t.Fatalf("agents delta = %d, want 3", got)
	}
	if got := seeded.AgentsNearQuota - before.AgentsNearQuota; got != 1 {
		t.Fatalf("near-quota delta = %d, want 1 (only the 950/1000 agent)", got)
	}
	if got := seeded.SpinePacks - before.SpinePacks; got != 4 {
		t.Fatalf("spine packs delta = %d, want 4", got)
	}
	if got := seeded.StoredBytes - before.StoredBytes; got != 1250 {
		t.Fatalf("stored bytes delta = %v, want 1250", got)
	}
	if got := seeded.QuotaBytes - before.QuotaBytes; got < float64(math.MaxInt64) {
		t.Fatalf("quota bytes delta = %v, want at least MaxInt64 without overflow", got)
	}
	if got := seeded.ActiveLeases - before.ActiveLeases; got != 2 {
		t.Fatalf("active leases delta at t=1500 = %d, want 2", got)
	}
	if got := seeded.WebhookIngressRows - before.WebhookIngressRows; got != 2 {
		t.Fatalf("webhook rows delta = %d, want 2", got)
	}

	// 过期的租约不再计入；主动释放的也不计入。
	later := mustTotals(t, st, 5_000)
	if got := later.ActiveLeases - before.ActiveLeases; got != 1 {
		t.Fatalf("active leases delta at t=5000 = %d, want 1 (short lease expired)", got)
	}
	if _, err := st.ReleaseLease(ctx, roomy, "dev", 1, 5_000); err != nil {
		t.Fatalf("release lease: %v", err)
	}
	if got := mustTotals(t, st, 5_000).ActiveLeases - before.ActiveLeases; got != 0 {
		t.Fatalf("active leases delta after release = %d, want 0", got)
	}

	// 删除账户级联带走它名下的一切。
	if _, err := st.DeleteAccount(ctx, acctA); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	after := mustTotals(t, st, 5_000)
	if after.Accounts-before.Accounts != 1 || after.Agents-before.Agents != 1 ||
		after.SpinePacks != before.SpinePacks || after.StoredBytes != before.StoredBytes ||
		after.AgentsNearQuota != before.AgentsNearQuota || after.WebhookIngressRows != before.WebhookIngressRows {
		t.Fatalf("totals after cascade delete: before=%+v after=%+v", before, after)
	}
	if _, err := st.DeleteAccount(ctx, acctB); err != nil {
		t.Fatalf("delete second account: %v", err)
	}
	if final := mustTotals(t, st, 5_000); final != before {
		t.Fatalf("totals did not return to baseline: before=%+v final=%+v", before, final)
	}
}

func TestSQLiteTotalsAggregateWithoutIdentifiers(t *testing.T) {
	st, err := NewSQLiteStore(filepath.Join(t.TempDir(), "hub.sqlite"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer func() { _ = st.Close() }()

	if empty := mustTotals(t, st, 1); empty != (Totals{}) {
		t.Fatalf("empty database must report all zeros, got %+v", empty)
	}
	exerciseTotals(t, st, "sqlite")
}

// 密文包数量是按每个 Agent 的最大 server_seq 推出来的，必须与真实行数一致。
func TestSQLiteTotalsPackCountMatchesRowCount(t *testing.T) {
	st, err := NewSQLiteStore(filepath.Join(t.TempDir(), "hub.sqlite"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()
	if err := st.CreateAccount(ctx, Account{AccountID: "acct", CreatedAtMs: 1}); err != nil {
		t.Fatalf("account: %v", err)
	}
	for agentIdx, packs := range []int{0, 1, 7, 23} {
		agentID := fmt.Sprintf("agent-%d", agentIdx)
		if err := st.CreateAgent(ctx, Agent{AgentID: agentID, OwnerAccountID: "acct", RootVerifyingKeyHex: "00", QuotaBytes: 1 << 20, CreatedAtMs: 1}); err != nil {
			t.Fatalf("agent: %v", err)
		}
		for i := 0; i < packs; i++ {
			commitTestPack(t, st, agentID, fmt.Sprintf("pack-%d-%d", agentIdx, i), int64(10+i))
		}
	}
	var rows int64
	var bytes float64
	if err := st.DBForTest().QueryRow(`SELECT COUNT(*), TOTAL(content_length) FROM spine_packs`).Scan(&rows, &bytes); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	totals := mustTotals(t, st, 1)
	if totals.SpinePacks != rows || rows != 31 {
		t.Fatalf("pack count = %d, row count = %d, want 31", totals.SpinePacks, rows)
	}
	if totals.StoredBytes != bytes {
		t.Fatalf("stored bytes = %v, sum of pack sizes = %v", totals.StoredBytes, bytes)
	}
}

func TestPostgresTotalsAggregateWithoutIdentifiers(t *testing.T) {
	dsn := os.Getenv("QUETZALCOATL_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("QUETZALCOATL_TEST_POSTGRES_DSN not set")
	}
	st, err := NewPostgresStore(dsn)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer func() { _ = st.Close() }()
	exerciseTotals(t, st, fmt.Sprintf("pg-%d", time.Now().UnixNano()))
}

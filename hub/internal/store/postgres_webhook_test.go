// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestPostgresWebhookIngressBatchIsAtomicAndCountsEvents(t *testing.T) {
	dsn := os.Getenv("QUETZALCOATL_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("QUETZALCOATL_TEST_POSTGRES_DSN not set")
	}
	st, err := NewPostgresStore(dsn)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	acct := "acct-" + suffix
	agent := "agent-" + suffix
	if err := st.CreateAccount(ctx, Account{AccountID: acct, CreatedAtMs: 1}); err != nil {
		t.Fatalf("account: %v", err)
	}
	if err := st.CreateAgent(ctx, Agent{AgentID: agent, OwnerAccountID: acct, RootVerifyingKeyHex: "00", QuotaBytes: 1 << 20, CreatedAtMs: 1}); err != nil {
		t.Fatalf("agent: %v", err)
	}
	rows := []WebhookIngressRow{
		{TargetDeviceID: "dev-a", HPKEEncHex: "aa", CiphertextHex: "bb", AADUTF8: "{}", ReceivedAtMs: 1, CreatedAtMs: 1},
		{TargetDeviceID: "dev-b", HPKEEncHex: "cc", CiphertextHex: "dd", AADUTF8: "{}", ReceivedAtMs: 1, CreatedAtMs: 1},
	}
	out, err := st.EnqueueWebhookIngressBatch(ctx, agent, "webhook", "hash1", rows, 1)
	if err != nil || out.Duplicate || out.Depth != 2 {
		t.Fatalf("first batch: out=%+v err=%v", out, err)
	}
	dup, err := st.EnqueueWebhookIngressBatch(ctx, agent, "webhook", "hash1", rows, 1)
	if err != nil || !dup.Duplicate || dup.Depth != 2 {
		t.Fatalf("duplicate: out=%+v err=%v", dup, err)
	}
	count, _ := st.CountWebhookIngress(ctx, agent)
	if count != 2 {
		t.Fatalf("duplicate must keep rows, got %d", count)
	}
	_, err = st.EnqueueWebhookIngressBatch(ctx, agent, "webhook", "hash2", rows[:1], 1)
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("expected quota, got %v", err)
	}
	events, _ := st.CountWebhookIngressEvents(ctx, agent)
	if events != 1 {
		t.Fatalf("quota rejection must leave one event, got %d", events)
	}
}

func TestPostgresWebhookIngressBatchDuplicateRaceIsIdempotent(t *testing.T) {
	dsn := os.Getenv("QUETZALCOATL_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("QUETZALCOATL_TEST_POSTGRES_DSN not set")
	}
	st, err := NewPostgresStore(dsn)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	acct := "acct-race-" + suffix
	agent := "agent-race-" + suffix
	if err := st.CreateAccount(ctx, Account{AccountID: acct, CreatedAtMs: 1}); err != nil {
		t.Fatalf("account: %v", err)
	}
	if err := st.CreateAgent(ctx, Agent{AgentID: agent, OwnerAccountID: acct, RootVerifyingKeyHex: "00", QuotaBytes: 1 << 20, CreatedAtMs: 1}); err != nil {
		t.Fatalf("agent: %v", err)
	}
	rows := []WebhookIngressRow{{TargetDeviceID: "dev-a", HPKEEncHex: "aa", CiphertextHex: "bb", AADUTF8: "{}", ReceivedAtMs: 1, CreatedAtMs: 1}}
	type result struct {
		out EnqueueOutcome
		err error
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			out, err := st.EnqueueWebhookIngressBatch(ctx, agent, "webhook", "same-hash", rows, 8)
			results <- result{out, err}
		}()
	}
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("duplicate race must be idempotent, got %v / %v", first.err, second.err)
	}
	if first.out.Duplicate == second.out.Duplicate {
		t.Fatalf("exactly one insert and one duplicate expected: %+v %+v", first, second)
	}
	count, _ := st.CountWebhookIngress(ctx, agent)
	if count != 1 {
		t.Fatalf("duplicate race must insert exactly one row, got %d", count)
	}
}

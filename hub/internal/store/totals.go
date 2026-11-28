// SPDX-License-Identifier: AGPL-3.0-only

package store

import "context"

// Totals 是给运行指标用的全库聚合：只有计数与字节数，不含任何账户、Agent 或设备标识。
//
// 取数成本与 Agent 数成正比，与密文包数量无关：
//   - 字节数直接累加 agents.used_bytes，不扫 spine_packs；
//   - 密文包数量按每个 Agent 的 MAX(server_seq) 累加（一次索引定位）。server_seq 从 1
//     起连续分配，且密文包只会随所属 Agent 一并删除，所以它恰等于行数。将来若引入
//     单包回收，这里必须改成事务内维护的计数，不能退回 COUNT(*)。
//
// AgentsNearQuota 统计已用字节达到自身配额 90% 的 Agent（配额为 0 的不计）。
// 字节合计用浮点累加，个别 Agent 被设成极大配额时不会整数溢出。
type Totals struct {
	Accounts           int64
	Agents             int64
	AgentsNearQuota    int64
	SpinePacks         int64
	StoredBytes        float64
	QuotaBytes         float64
	ActiveLeases       int64
	WebhookIngressRows int64
}

func (s *SQLiteStore) Totals(ctx context.Context, nowMs int64) (Totals, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var t Totals
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts`).Scan(&t.Accounts); err != nil {
		return Totals{}, err
	}
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			TOTAL(used_bytes),
			TOTAL(quota_bytes),
			COALESCE(SUM(CASE WHEN quota_bytes > 0 AND used_bytes >= quota_bytes - quota_bytes / 10 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM((SELECT COALESCE(MAX(sp.server_seq), 0) FROM spine_packs sp WHERE sp.agent_id = ag.agent_id)), 0)
		FROM agents ag
	`).Scan(&t.Agents, &t.StoredBytes, &t.QuotaBytes, &t.AgentsNearQuota, &t.SpinePacks); err != nil {
		return Totals{}, err
	}
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM leases WHERE holder_device_id != '' AND expires_at_ms > ?`, nowMs,
	).Scan(&t.ActiveLeases); err != nil {
		return Totals{}, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue`).Scan(&t.WebhookIngressRows); err != nil {
		return Totals{}, err
	}
	return t, nil
}

func (p *PostgresStore) Totals(ctx context.Context, nowMs int64) (Totals, error) {
	var t Totals
	if err := p.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts`).Scan(&t.Accounts); err != nil {
		return Totals{}, err
	}
	if err := p.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(used_bytes::double precision), 0),
			COALESCE(SUM(quota_bytes::double precision), 0),
			COALESCE(SUM(CASE WHEN quota_bytes > 0 AND used_bytes >= quota_bytes - quota_bytes / 10 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM((SELECT COALESCE(MAX(sp.server_seq), 0) FROM spine_packs sp WHERE sp.agent_id = ag.agent_id)), 0)::bigint
		FROM agents ag
	`).Scan(&t.Agents, &t.StoredBytes, &t.QuotaBytes, &t.AgentsNearQuota, &t.SpinePacks); err != nil {
		return Totals{}, err
	}
	if err := p.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM leases WHERE holder_device_id != '' AND expires_at_ms > $1`, nowMs,
	).Scan(&t.ActiveLeases); err != nil {
		return Totals{}, err
	}
	if err := p.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM webhook_ingress_queue`).Scan(&t.WebhookIngressRows); err != nil {
		return Totals{}, err
	}
	return t, nil
}

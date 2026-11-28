// 治理面与守护进程之间的载荷（docs/GOVERNANCE_SURFACE.md 第 3 节）。时间一律是毫秒时间戳。

export type SyncState = "local-only" | "synced" | "behind";

export interface OverviewHost {
  host: string;
  name: string;
  connected: boolean;
  last_seen_ms: number | null;
}

export interface SeaOverview {
  agent: { name: string; since_ms: number };
  baseline: { signed: boolean; directive_count: number; signed_at_ms: number | null };
  counts: { core_values: number; about_user: number; memories: number; muted: number };
  pending: { disclosures: number; approvals: number };
  hosts: OverviewHost[];
  sync: { state: SyncState; hub_url: string | null; devices: number; last_synced_ms: number | null };
}

export interface IdentityItem {
  id: string;
  label: string;
  text: string;
  layer: string;
  since_ms: number;
}

export interface CoreValue {
  id: string;
  statement: string;
  rationale: string | null;
  since_ms: number;
  evidence_count: number;
}

export interface TemperamentItem {
  id: string;
  statement: string;
  since_ms: number;
}

export interface ChangeEvidence {
  episode_id: string;
  host: string;
  at_ms: number;
}

export interface SelfChange {
  id: string;
  target_id: string;
  summary: string;
  at_ms: number;
  acknowledged: boolean;
  evidence: ChangeEvidence[];
}

export interface SeaSelf {
  identity: IdentityItem[];
  core_values: CoreValue[];
  temperament: TemperamentItem[];
  changes: SelfChange[];
  lately: SelfLately;
}

/** 他独处时：回想、出去读、想先提的事，和你给他定的节律。 */
export interface SelfLately {
  last_reflected_ms: number | null;
  last_explored_ms: number | null;
  curious: string[];
  bring_up: string | null;
  read: LatelyRead[];
  speak_first: boolean;
  /** 不打扰的时段：[开始的钟点, 结束的钟点]，本地时间，含头不含尾。 */
  quiet_hours: number[] | null;
}

export interface LatelyRead {
  id: string;
  text: string;
  at_ms: number;
}

export interface Preference {
  id: string;
  statement: string;
  since_ms: number;
  by_owner: boolean;
}

export type MemorySourceKind = "host" | "import" | "sayit" | "explore" | "owner";

export interface MemorySource {
  kind: MemorySourceKind;
  label: string;
}

export interface MemoryItem {
  id: string;
  text: string;
  layer: string;
  topic: string | null;
  since_ms: number;
  valid_until_ms: number | null;
  muted: boolean;
  untrusted: boolean;
  by_owner: boolean;
  source: MemorySource;
}

export type MemoryHistoryAction = "created" | "corrected" | "muted" | "unmuted" | "expired";

export interface MemoryHistoryEntry {
  at_ms: number;
  action: MemoryHistoryAction;
  by: string;
}

export interface MemoryDetail extends MemoryItem {
  supersedes: string | null;
  history: MemoryHistoryEntry[];
}

export interface SeaUser {
  preferences: Preference[];
  facts: MemoryItem[];
}

export interface Relation {
  id: string;
  peer: string;
  commitments: string[];
  their_model: string[];
  trust: number;
}

export interface Focus {
  self_weight: number;
  us_weight: number;
  floor_self: number;
  floor_locked: boolean;
}

export interface SeaUs {
  relations: Relation[];
  focus: Focus;
}

export interface Directive {
  id: string;
  title: string;
  text: string;
}

export interface DirectiveDraft {
  title: string;
  text: string;
}

export interface Baseline {
  signed: boolean;
  signed_at_ms: number | null;
  directives: Directive[];
  deployment: Directive[];
}

export type HostCheckKey = "core" | "recall" | "signal" | "compaction";

export interface HostCheck {
  key: HostCheckKey;
  ok: boolean;
  detail: string;
}

export interface HostView {
  host: string;
  name: string;
  installed: boolean;
  version: string | null;
  connected: boolean;
  checks: HostCheck[];
}

export interface HostsView {
  hosts: HostView[];
}

export interface DeviceSummary {
  id: string;
  name: string;
  added_ms: number;
}

export interface Device extends DeviceSummary {
  last_seen_ms: number | null;
  holds_control: boolean;
}

export interface DevicesView {
  this_device: DeviceSummary;
  devices: Device[];
  hub: { url: string | null; connected: boolean };
}

export type AuditActor = "owner" | "arbiter" | "import" | "system";

export interface AuditItem {
  seq: number;
  at_ms: number;
  kind: string;
  summary: string;
  actor: AuditActor;
  entry_id: string | null;
}

export type MemoryState = "active" | "muted" | "expired";

export interface MemoriesQuery {
  query?: string;
  state?: MemoryState;
  cursor?: string;
  limit?: number;
}

export interface MemoriesPage {
  items: MemoryItem[];
  next_cursor: string | null;
  total: number;
}

export interface AuditQuery {
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  items: AuditItem[];
  next_cursor: string | null;
}

export interface EntryWrite {
  id: string;
  audit_seq: number;
}

export interface BaselineSigned {
  signed_at_ms: number;
}

/** 十六个方法：十个读、六个写。`params: null` 表示这个方法没有参数，请求体不带 `params`。 */
export interface SeaMethods {
  sea_overview: { params: null; result: SeaOverview };
  sea_self: { params: null; result: SeaSelf };
  sea_user: { params: null; result: SeaUser };
  sea_us: { params: null; result: SeaUs };
  sea_memories: { params: MemoriesQuery; result: MemoriesPage };
  sea_memory: { params: { id: string }; result: MemoryDetail };
  sea_baseline: { params: null; result: Baseline };
  sea_hosts: { params: null; result: HostsView };
  sea_devices: { params: null; result: DevicesView };
  sea_audit: { params: AuditQuery; result: AuditPage };
  sea_entry_update: { params: { id: string; text: string }; result: EntryWrite };
  sea_entry_mute: { params: { id: string; muted: boolean }; result: EntryWrite };
  sea_entry_erase: { params: { id: string }; result: EntryWrite };
  sea_baseline_sign: {
    params: { directives: DirectiveDraft[]; passphrase: string };
    result: BaselineSigned;
  };
  sea_focus_set: { params: { self_weight: number }; result: SeaUs };
  sea_rhythm_set: {
    params: { speak_first: boolean; quiet_hours: number[] | null };
    result: SeaSelf;
  };
  sea_device_revoke: { params: { device_id: string; passphrase: string }; result: DevicesView };
}

export type SeaMethod = keyof SeaMethods;

export const SEA_READ_METHODS = [
  "sea_overview",
  "sea_self",
  "sea_user",
  "sea_us",
  "sea_memories",
  "sea_memory",
  "sea_baseline",
  "sea_hosts",
  "sea_devices",
  "sea_audit",
] as const satisfies readonly SeaMethod[];

export const SEA_WRITE_METHODS = [
  "sea_entry_update",
  "sea_entry_mute",
  "sea_entry_erase",
  "sea_baseline_sign",
  "sea_focus_set",
  "sea_rhythm_set",
  "sea_device_revoke",
] as const satisfies readonly SeaMethod[];

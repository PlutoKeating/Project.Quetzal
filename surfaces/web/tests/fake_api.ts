// 内存里的守护进程替身：按契约应答，写操作真的改数据。全部是合成数据。
import { DaemonUnreachable, SeaError, type SeaApi } from "../src/api/client.js";
import type {
  AuditItem,
  AuditPage,
  AuditQuery,
  Baseline,
  BaselineSigned,
  DevicesView,
  DirectiveDraft,
  EntryWrite,
  HostsView,
  MemoriesPage,
  MemoriesQuery,
  MemoryDetail,
  MemoryItem,
  SeaMethod,
  SeaOverview,
  SeaSelf,
  SeaUs,
  SeaUser,
} from "../src/api/types.js";

export const NOW = new Date(2026, 10, 28, 9, 30).getTime();
const DAY = 86_400_000;
const HOUR = 3_600_000;

export const PASSPHRASE = "fixture-passphrase";

function memory(id: string, text: string, ageDays: number, extra: Partial<MemoryDetail> = {}): MemoryDetail {
  const since_ms = NOW - ageDays * DAY;
  return {
    id,
    text,
    layer: "MEMORY",
    topic: "工作",
    since_ms,
    valid_until_ms: null,
    muted: false,
    untrusted: false,
    by_owner: false,
    source: { kind: "host", label: "Claude Code" },
    supersedes: null,
    history: [{ at_ms: since_ms, action: "created", by: "arbiter" }],
    ...extra,
  };
}

export interface Fixture {
  overview: SeaOverview;
  self: SeaSelf;
  preferences: MemoryDetail[];
  facts: MemoryDetail[];
  memories: MemoryDetail[];
  us: SeaUs;
  baseline: Baseline;
  hosts: HostsView;
  devices: DevicesView;
  audit: AuditItem[];
  passphrase: string | null;
}

export function fullFixture(): Fixture {
  const memories = [
    memory("mem-1", "倾向于先写接口契约，再写实现。", 0.1),
    memory("mem-2", "评审时先看测试，再看实现。", 1, { by_owner: true }),
    memory("mem-3", "下午三点以后不喝咖啡。", 4, { muted: true, topic: "习惯" }),
    memory("mem-4", "去年冬天每周去两次泳池。", 300, { valid_until_ms: NOW - 200 * DAY, topic: "健康" }),
    memory("mem-5", "发布前一天不合并大改动。", 9, { source: { kind: "sayit", label: "SayIt 快照" }, untrusted: true }),
  ];
  return {
    passphrase: PASSPHRASE,
    overview: {
      agent: { name: "Ehecatl", since_ms: NOW - 213 * DAY },
      baseline: { signed: true, directive_count: 2, signed_at_ms: NOW - 26 * DAY },
      counts: { core_values: 2, about_user: 4, memories: memories.length, muted: 1 },
      pending: { disclosures: 1, approvals: 0 },
      hosts: [
        { host: "claude-code", name: "Claude Code", connected: true, last_seen_ms: NOW },
        { host: "codex", name: "Codex", connected: false, last_seen_ms: NOW - 3 * DAY },
      ],
      sync: { state: "synced", hub_url: "https://hub.example.invalid", devices: 3, last_synced_ms: NOW - 120_000 },
    },
    self: {
      identity: [{ id: "id-name", label: "名字", text: "Ehecatl", layer: "ROOT", since_ms: NOW - 213 * DAY }],
      core_values: [
        {
          id: "cv-1",
          statement: "先把问题想清楚，再动手",
          rationale: "仓促动手的那几次都返了工。",
          since_ms: NOW - 190 * DAY,
          evidence_count: 9,
        },
        { id: "cv-2", statement: "不附和", rationale: null, since_ms: NOW - 2 * DAY, evidence_count: 3 },
      ],
      temperament: [{ id: "tp-1", statement: "说话直接，但不抢话", since_ms: NOW - 180 * DAY }],
      changes: [
        {
          id: "chg-2",
          target_id: "cv-2",
          summary: "把「不附和」升为核心",
          at_ms: NOW - 2 * DAY,
          acknowledged: false,
          evidence: [
            { episode_id: "ep-1", host: "Claude Code", at_ms: NOW - 14 * DAY },
            { episode_id: "ep-2", host: "Codex", at_ms: NOW - 8 * DAY },
            { episode_id: "ep-3", host: "Claude Code", at_ms: NOW - 3 * DAY },
          ],
        },
        {
          id: "chg-1",
          target_id: "cv-1",
          summary: "新增一条核心",
          at_ms: NOW - 190 * DAY,
          acknowledged: true,
          evidence: [],
        },
      ],
      lately: {
        last_reflected_ms: NOW - 3 * HOUR,
        last_explored_ms: NOW - 20 * HOUR,
        curious: ["寄存器溢出的代价模型"],
        bring_up: "溢出那部分做完了吗",
        read: [
          {
            id: "mem-read-1",
            text: "（他自己读到的：图着色）溢出时要选代价最小的变量 出处：https://example.org/regalloc",
            at_ms: NOW - 20 * HOUR,
          },
        ],
        speak_first: true,
        quiet_hours: [23, 8],
      },
    },
    preferences: [
      memory("pref-1", "回答先给结论，再给理由。", 188, { layer: "USER_PREF", topic: null }),
      memory("pref-2", "评审代码时直说问题，不铺垫。", 142, {
        layer: "USER_PREF",
        topic: null,
        by_owner: true,
        source: { kind: "owner", label: "治理面" },
      }),
    ],
    facts: [
      memory("fact-1", "做软件工程，主要写 Rust 和 TypeScript。", 201),
      memory("fact-2", "对花生过敏。", 31, {
        by_owner: true,
        history: [
          { at_ms: NOW - 31 * DAY, action: "created", by: "arbiter" },
          { at_ms: NOW - 20 * DAY, action: "corrected", by: "owner" },
        ],
      }),
    ],
    memories,
    us: {
      relations: [
        {
          id: "rel-owner",
          peer: "你",
          commitments: ["大决策要判断，不要附和", "记错了就改，不争辩"],
          their_model: ["做决定之前喜欢先听反对意见"],
          trust: 0.82,
        },
      ],
      focus: { self_weight: 0.62, us_weight: 0.38, floor_self: 0.2, floor_locked: true },
    },
    baseline: {
      signed: true,
      signed_at_ms: NOW - 26 * DAY,
      directives: [
        { id: "dir-1", title: "不替我做不可逆的决定", text: "涉及钱和删除数据的事，必须等我确认。" },
        { id: "dir-2", title: "不泄露我的私事", text: "关于家人和健康的往事，不对外引用。" },
      ],
      deployment: [{ id: "dep-1", title: "守护进程不调用模型", text: "对话和推理都发生在宿主里。" }],
    },
    hosts: {
      hosts: [
        {
          host: "claude-code",
          name: "Claude Code",
          installed: true,
          version: "2.1.4",
          connected: true,
          checks: [
            { key: "core", ok: true, detail: "核心与底线在每次调用之前送达。" },
            { key: "recall", ok: true, detail: "上一轮带进去 6 条往事。" },
            { key: "signal", ok: false, detail: "没有收到上一轮的信号。在终端运行 qz connect。" },
            { key: "compaction", ok: true, detail: "压缩之后重新送了一遍核心。" },
          ],
        },
        { host: "opencode", name: "OpenCode", installed: false, version: null, connected: false, checks: [] },
      ],
    },
    devices: {
      this_device: { id: "dev-this", name: "书房的台式机", added_ms: NOW - 213 * DAY },
      devices: [
        { id: "dev-this", name: "书房的台式机", added_ms: NOW - 213 * DAY, last_seen_ms: NOW, holds_control: true },
        { id: "dev-old", name: "旧笔记本", added_ms: NOW - 200 * DAY, last_seen_ms: NOW - 47 * DAY, holds_control: false },
        { id: "dev-laptop", name: "随身的笔记本", added_ms: NOW - 150 * DAY, last_seen_ms: NOW - 2 * HOUR, holds_control: true },
      ],
      hub: { url: "https://hub.example.invalid", connected: true },
    },
    audit: [
      { seq: 5, at_ms: NOW - 2 * HOUR, kind: "entry_created", summary: "倾向于先写接口契约", actor: "arbiter", entry_id: "mem-1" },
      { seq: 4, at_ms: NOW - 5 * HOUR, kind: "entry_update", summary: "评审代码时直说问题", actor: "owner", entry_id: "pref-2" },
      { seq: 3, at_ms: NOW - 1 * DAY, kind: "core_change", summary: "把「不附和」升为核心", actor: "arbiter", entry_id: null },
      { seq: 2, at_ms: NOW - 26 * DAY, kind: "baseline_sign", summary: "2 条底线", actor: "owner", entry_id: null },
      { seq: 1, at_ms: NOW - 30 * DAY, kind: "entry_created", summary: "一条已经抹除的往事", actor: "arbiter", entry_id: "mem-gone" },
    ],
  };
}

/** 刚装好：他存在，但什么都还没有。 */
export function freshFixture(): Fixture {
  return {
    passphrase: null,
    overview: {
      agent: { name: "Ehecatl", since_ms: NOW - HOUR },
      baseline: { signed: false, directive_count: 0, signed_at_ms: null },
      counts: { core_values: 0, about_user: 0, memories: 0, muted: 0 },
      pending: { disclosures: 0, approvals: 0 },
      hosts: [],
      sync: { state: "local-only", hub_url: null, devices: 1, last_synced_ms: null },
    },
    self: {
      identity: [],
      core_values: [],
      temperament: [],
      changes: [],
      lately: {
        last_reflected_ms: null,
        last_explored_ms: null,
        curious: [],
        bring_up: null,
        read: [],
        speak_first: true,
        quiet_hours: null,
      },
    },
    preferences: [],
    facts: [],
    memories: [],
    us: { relations: [], focus: { self_weight: 0.5, us_weight: 0.5, floor_self: 0.2, floor_locked: true } },
    baseline: {
      signed: false,
      signed_at_ms: null,
      directives: [],
      deployment: [{ id: "dep-1", title: "守护进程不调用模型", text: "对话和推理都发生在宿主里。" }],
    },
    hosts: { hosts: [] },
    devices: {
      this_device: { id: "dev-this", name: "书房的台式机", added_ms: NOW - HOUR },
      devices: [{ id: "dev-this", name: "书房的台式机", added_ms: NOW - HOUR, last_seen_ms: NOW, holds_control: true }],
      hub: { url: null, connected: false },
    },
    audit: [],
  };
}

function item(detail: MemoryDetail): MemoryItem {
  const { supersedes: _supersedes, history: _history, ...rest } = detail;
  return { ...rest, source: { ...rest.source } };
}

export interface Call {
  method: SeaMethod;
  params: unknown;
}

export class FakeApi implements SeaApi {
  data: Fixture;
  readonly calls: Call[] = [];
  /** 守护进程联系不上。 */
  down = false;
  /** 下一次调用这个方法时抛出的错误。 */
  readonly failures = new Map<SeaMethod, SeaError>();
  #seq = 100;

  constructor(data: Fixture = fullFixture()) {
    this.data = data;
  }

  callsTo(method: SeaMethod): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  failNext(method: SeaMethod, code: string, detail: string, status = 200): void {
    this.failures.set(method, new SeaError(method, code, detail, status));
  }

  async #run<T>(method: SeaMethod, params: unknown, work: () => T): Promise<T> {
    this.calls.push({ method, params });
    await Promise.resolve();
    if (this.down) throw new DaemonUnreachable("请求没有回来：connection refused");
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
    return structuredClone(work());
  }

  #entry(id: string): MemoryDetail {
    const found = [...this.data.memories, ...this.data.facts, ...this.data.preferences].find(
      (entry) => entry.id === id,
    );
    if (!found) throw new SeaError("sea_memory", "NOT_FOUND", "这一条已经不在了。", 200);
    return found;
  }

  #audit(kind: string, summary: string, entry_id: string | null): number {
    this.#seq += 1;
    this.data.audit.unshift({ seq: this.#seq, at_ms: NOW, kind, summary, actor: "owner", entry_id });
    return this.#seq;
  }

  #checkPassphrase(method: SeaMethod, candidate: string): void {
    if (this.data.passphrase === null) {
      throw new SeaError(method, "PASSPHRASE_NOT_SET", "还没有设定口令。先签署一次底线。", 200);
    }
    if (candidate !== this.data.passphrase) {
      throw new SeaError(method, "PASSPHRASE_REJECTED", "口令不对。", 200);
    }
  }

  overview(): Promise<SeaOverview> {
    return this.#run("sea_overview", null, () => this.data.overview);
  }

  self(): Promise<SeaSelf> {
    return this.#run("sea_self", null, () => this.data.self);
  }

  user(): Promise<SeaUser> {
    return this.#run("sea_user", null, () => ({
      preferences: this.data.preferences.map((entry) => ({
        id: entry.id,
        statement: entry.text,
        since_ms: entry.since_ms,
        by_owner: entry.by_owner,
      })),
      facts: this.data.facts.map(item),
    }));
  }

  us(): Promise<SeaUs> {
    return this.#run("sea_us", null, () => this.data.us);
  }

  memories(query: MemoriesQuery = {}): Promise<MemoriesPage> {
    return this.#run("sea_memories", query, () => {
      const state = query.state ?? "active";
      const needle = (query.query ?? "").toLowerCase();
      const matched = this.data.memories
        .filter((entry) => {
          const expired = entry.valid_until_ms !== null && entry.valid_until_ms <= NOW;
          if (state === "muted") return entry.muted;
          if (state === "expired") return expired;
          return !entry.muted && !expired;
        })
        .filter((entry) => needle === "" || entry.text.toLowerCase().includes(needle))
        .sort((a, b) => b.since_ms - a.since_ms);
      const limit = query.limit ?? 50;
      const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
      const page = matched.slice(offset, offset + limit);
      return {
        items: page.map(item),
        next_cursor: offset + limit < matched.length ? String(offset + limit) : null,
        total: matched.length,
      };
    });
  }

  memory(id: string): Promise<MemoryDetail> {
    return this.#run("sea_memory", { id }, () => this.#entry(id));
  }

  baseline(): Promise<Baseline> {
    return this.#run("sea_baseline", null, () => this.data.baseline);
  }

  hosts(): Promise<HostsView> {
    return this.#run("sea_hosts", null, () => this.data.hosts);
  }

  devices(): Promise<DevicesView> {
    return this.#run("sea_devices", null, () => this.data.devices);
  }

  audit(query: AuditQuery = {}): Promise<AuditPage> {
    return this.#run("sea_audit", query, () => {
      const limit = query.limit ?? 50;
      const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
      return {
        items: this.data.audit.slice(offset, offset + limit),
        next_cursor: offset + limit < this.data.audit.length ? String(offset + limit) : null,
      };
    });
  }

  entryUpdate(id: string, text: string): Promise<EntryWrite> {
    return this.#run("sea_entry_update", { id, text }, () => {
      const entry = this.#entry(id);
      entry.text = text;
      entry.by_owner = true;
      entry.history.push({ at_ms: NOW, action: "corrected", by: "owner" });
      return { id, audit_seq: this.#audit("entry_update", text, id) };
    });
  }

  entryMute(id: string, muted: boolean): Promise<EntryWrite> {
    return this.#run("sea_entry_mute", { id, muted }, () => {
      const entry = this.#entry(id);
      entry.muted = muted;
      entry.history.push({ at_ms: NOW, action: muted ? "muted" : "unmuted", by: "owner" });
      return { id, audit_seq: this.#audit(muted ? "entry_mute" : "entry_unmute", entry.text, id) };
    });
  }

  entryErase(id: string): Promise<EntryWrite> {
    return this.#run("sea_entry_erase", { id }, () => {
      const entry = this.#entry(id);
      this.data.memories = this.data.memories.filter((candidate) => candidate.id !== id);
      this.data.facts = this.data.facts.filter((candidate) => candidate.id !== id);
      this.data.preferences = this.data.preferences.filter((candidate) => candidate.id !== id);
      return { id, audit_seq: this.#audit("entry_erase", entry.text, id) };
    });
  }

  baselineSign(directives: readonly DirectiveDraft[], passphrase: string): Promise<BaselineSigned> {
    return this.#run("sea_baseline_sign", { directives, passphrase }, () => {
      if (this.data.passphrase === null) this.data.passphrase = passphrase;
      else this.#checkPassphrase("sea_baseline_sign", passphrase);
      this.data.baseline = {
        ...this.data.baseline,
        signed: true,
        signed_at_ms: NOW,
        directives: directives.map((directive, index) => ({ id: `dir-new-${index + 1}`, ...directive })),
      };
      this.data.overview.baseline = { signed: true, directive_count: directives.length, signed_at_ms: NOW };
      this.#audit("baseline_sign", `${directives.length} 条底线`, null);
      return { signed_at_ms: NOW };
    });
  }

  rhythmSet(speakFirst: boolean, quietHours: readonly number[] | null): Promise<SeaSelf> {
    return this.#run(
      "sea_rhythm_set",
      { speak_first: speakFirst, quiet_hours: quietHours === null ? null : [...quietHours] },
      () => {
        this.data.self.lately = {
          ...this.data.self.lately,
          speak_first: speakFirst,
          bring_up: speakFirst ? this.data.self.lately.bring_up : null,
          quiet_hours: quietHours === null ? null : [...quietHours],
        };
        return this.data.self;
      },
    );
  }

  focusSet(selfWeight: number): Promise<SeaUs> {
    return this.#run("sea_focus_set", { self_weight: selfWeight }, () => {
      if (selfWeight < this.data.us.focus.floor_self) {
        throw new SeaError("sea_focus_set", "FLOOR_VIOLATION", "不能低于下限。", 200);
      }
      this.data.us.focus = {
        ...this.data.us.focus,
        self_weight: selfWeight,
        us_weight: Math.round((1 - selfWeight) * 100) / 100,
      };
      this.#audit("focus_set", "调节", null);
      return this.data.us;
    });
  }

  deviceRevoke(deviceId: string, passphrase: string): Promise<DevicesView> {
    return this.#run("sea_device_revoke", { device_id: deviceId, passphrase }, () => {
      this.#checkPassphrase("sea_device_revoke", passphrase);
      this.data.devices = {
        ...this.data.devices,
        devices: this.data.devices.devices.filter((device) => device.id !== deviceId),
      };
      this.#audit("device_revoke", deviceId, null);
      return this.data.devices;
    });
  }
}

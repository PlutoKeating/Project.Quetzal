// 载荷解码：守护进程返回的 JSON 在进入界面之前逐字段核对。
// 形状不符时抛出带路径的 DecodeError，界面据此显示「读不懂」的状态，而不是在渲染中途崩溃。
import type {
  AuditItem,
  AuditPage,
  Baseline,
  BaselineSigned,
  Device,
  DevicesView,
  Directive,
  EntryWrite,
  HostView,
  HostsView,
  MemoriesPage,
  MemoryDetail,
  MemoryItem,
  SeaMethod,
  SeaMethods,
  SeaOverview,
  SeaSelf,
  SeaUs,
  SeaUser,
} from "./types.js";

export class DecodeError extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path} 应为 ${expected}`);
    this.name = "DecodeError";
    this.path = path;
  }
}

export type Decoder<T> = (value: unknown, path: string) => T;

const str: Decoder<string> = (value, path) => {
  if (typeof value !== "string") throw new DecodeError(path, "字符串");
  return value;
};

const num: Decoder<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DecodeError(path, "数字");
  return value;
};

const bool: Decoder<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw new DecodeError(path, "布尔值");
  return value;
};

function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null || value === undefined ? null : inner(value, path));
}

function arr<T>(inner: Decoder<T>): Decoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new DecodeError(path, "数组");
    return value.map((item, index) => inner(item, `${path}[${index}]`));
  };
}

function oneOf<const T extends readonly string[]>(options: T): Decoder<T[number]> {
  return (value, path) => {
    if (typeof value === "string" && options.includes(value)) return value;
    throw new DecodeError(path, options.join(" | "));
  };
}

function obj<T>(shape: { [K in keyof T]: Decoder<T[K]> }): Decoder<T> {
  return (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DecodeError(path, "对象");
    }
    const record = value as Record<string, unknown>;
    const out = {} as T;
    for (const key of Object.keys(shape) as Array<keyof T & string>) {
      out[key] = shape[key](record[key], `${path}.${key}`);
    }
    return out;
  };
}

const overview: Decoder<SeaOverview> = obj<SeaOverview>({
  agent: obj({ name: str, since_ms: num }),
  baseline: obj({ signed: bool, directive_count: num, signed_at_ms: nullable(num) }),
  counts: obj({ core_values: num, about_user: num, memories: num, muted: num }),
  pending: obj({ disclosures: num, approvals: num }),
  hosts: arr(obj({ host: str, name: str, connected: bool, last_seen_ms: nullable(num) })),
  sync: obj({
    state: oneOf(["local-only", "synced", "behind"]),
    hub_url: nullable(str),
    devices: num,
    last_synced_ms: nullable(num),
  }),
});

const self: Decoder<SeaSelf> = obj<SeaSelf>({
  identity: arr(obj({ id: str, label: str, text: str, layer: str, since_ms: num })),
  core_values: arr(
    obj({ id: str, statement: str, rationale: nullable(str), since_ms: num, evidence_count: num }),
  ),
  temperament: arr(obj({ id: str, statement: str, since_ms: num })),
  changes: arr(
    obj({
      id: str,
      target_id: str,
      summary: str,
      at_ms: num,
      acknowledged: bool,
      evidence: arr(obj({ episode_id: str, host: str, at_ms: num })),
    }),
  ),
  lately: obj({
    last_reflected_ms: nullable(num),
    last_explored_ms: nullable(num),
    curious: arr(str),
    bring_up: nullable(str),
    read: arr(obj({ id: str, text: str, at_ms: num })),
    speak_first: bool,
    quiet_hours: nullable(arr(num)),
  }),
});

const memoryShape = {
  id: str,
  text: str,
  layer: str,
  topic: nullable(str),
  since_ms: num,
  valid_until_ms: nullable(num),
  muted: bool,
  untrusted: bool,
  by_owner: bool,
  source: obj({ kind: oneOf(["host", "import", "sayit", "explore", "owner"]), label: str }),
};

const memoryItem: Decoder<MemoryItem> = obj<MemoryItem>(memoryShape);

const memoryDetail: Decoder<MemoryDetail> = obj<MemoryDetail>({
  ...memoryShape,
  supersedes: nullable(str),
  history: arr(
    obj({
      at_ms: num,
      action: oneOf(["created", "corrected", "muted", "unmuted", "expired"]),
      by: str,
    }),
  ),
});

const user: Decoder<SeaUser> = obj<SeaUser>({
  preferences: arr(obj({ id: str, statement: str, since_ms: num, by_owner: bool })),
  facts: arr(memoryItem),
});

const us: Decoder<SeaUs> = obj<SeaUs>({
  relations: arr(
    obj({ id: str, peer: str, commitments: arr(str), their_model: arr(str), trust: num }),
  ),
  focus: obj({ self_weight: num, us_weight: num, floor_self: num, floor_locked: bool }),
});

const memories: Decoder<MemoriesPage> = obj<MemoriesPage>({
  items: arr(memoryItem),
  next_cursor: nullable(str),
  total: num,
});

const directive: Decoder<Directive> = obj<Directive>({ id: str, title: str, text: str });

const baseline: Decoder<Baseline> = obj<Baseline>({
  signed: bool,
  signed_at_ms: nullable(num),
  directives: arr(directive),
  deployment: arr(directive),
});

const hostView: Decoder<HostView> = obj<HostView>({
  host: str,
  name: str,
  installed: bool,
  version: nullable(str),
  connected: bool,
  checks: arr(
    obj({ key: oneOf(["core", "recall", "signal", "compaction"]), ok: bool, detail: str }),
  ),
});

const hosts: Decoder<HostsView> = obj<HostsView>({ hosts: arr(hostView) });

const device: Decoder<Device> = obj<Device>({
  id: str,
  name: str,
  added_ms: num,
  last_seen_ms: nullable(num),
  holds_control: bool,
});

const devices: Decoder<DevicesView> = obj<DevicesView>({
  this_device: obj({ id: str, name: str, added_ms: num }),
  devices: arr(device),
  hub: obj({ url: nullable(str), connected: bool }),
});

const auditItem: Decoder<AuditItem> = obj<AuditItem>({
  seq: num,
  at_ms: num,
  kind: str,
  summary: str,
  actor: oneOf(["owner", "arbiter", "import", "system"]),
  entry_id: nullable(str),
});

const audit: Decoder<AuditPage> = obj<AuditPage>({
  items: arr(auditItem),
  next_cursor: nullable(str),
});

const entryWrite: Decoder<EntryWrite> = obj<EntryWrite>({ id: str, audit_seq: num });

const baselineSigned: Decoder<BaselineSigned> = obj<BaselineSigned>({ signed_at_ms: num });

export const RESULT_DECODERS: { [M in SeaMethod]: Decoder<SeaMethods[M]["result"]> } = {
  sea_overview: overview,
  sea_self: self,
  sea_user: user,
  sea_us: us,
  sea_memories: memories,
  sea_memory: memoryDetail,
  sea_baseline: baseline,
  sea_hosts: hosts,
  sea_devices: devices,
  sea_audit: audit,
  sea_entry_update: entryWrite,
  sea_entry_mute: entryWrite,
  sea_entry_erase: entryWrite,
  sea_baseline_sign: baselineSigned,
  sea_focus_set: us,
  sea_rhythm_set: self,
  sea_device_revoke: devices,
};

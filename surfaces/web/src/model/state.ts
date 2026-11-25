// 与 `quetzalcoatl-client-core::view_models` 逐字段对齐的浏览器侧状态机。
// 守护进程只推送 ViewPatch；客户端按 from_rev → to_rev 幂等重放，乱序补丁显式拒绝。

export const DENSITIES = ["companion", "workbench", "inspector"] as const;
export type Density = (typeof DENSITIES)[number];
export type Layer = "summary" | "detail" | "raw";

export interface ViewRow {
  key: string;
  kind: string;
  summary: string;
  detail?: string;
  raw_json?: string;
  updated_rev: number;
}

export type ViewOp = { op: "upsert"; row: ViewRow } | { op: "remove"; key: string };

export interface ViewPatch {
  from_rev: number;
  to_rev: number;
  density: Density;
  ops: ViewOp[];
}

export interface ViewSnapshot {
  rev: number;
  density: Density;
  rows: Record<string, ViewRow>;
}

export interface ProjectedRow {
  key: string;
  kind: string;
  summary: string;
  detail?: string;
  raw_json?: string;
  updated_rev: number;
}

export type PatchErrorCode = "OUT_OF_SEQUENCE" | "INVALID_REVISION" | "MALFORMED_OP";

export class PatchSequenceError extends Error {
  readonly code: PatchErrorCode;

  constructor(code: PatchErrorCode, message: string) {
    super(message);
    this.name = "PatchSequenceError";
    this.code = code;
  }
}

export function isDensity(value: unknown): value is Density {
  return value === "companion" || value === "workbench" || value === "inspector";
}

export function isLayerVisible(density: Density, layer: Layer): boolean {
  switch (layer) {
    case "summary":
      return true;
    case "detail":
      return density !== "companion";
    case "raw":
      return density === "inspector";
  }
}

export function densityLabel(density: Density): string {
  return density === "companion" ? "陪伴" : density === "workbench" ? "工作台" : "检视";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 宽松解析守卫：服务端字段可能带 `null`，统一归一为 `undefined`。 */
export function normalizeRow(value: unknown): ViewRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const key = optionalString(record["key"]);
  const kind = optionalString(record["kind"]);
  const summary = typeof record["summary"] === "string" ? record["summary"] : undefined;
  if (!key || !kind || summary === undefined) return null;
  const updated = record["updated_rev"];
  const row: ViewRow = {
    key,
    kind,
    summary,
    updated_rev: typeof updated === "number" && Number.isFinite(updated) ? updated : 0,
  };
  const detail = optionalString(record["detail"]);
  if (detail !== undefined) row.detail = detail;
  const raw = optionalString(record["raw_json"]);
  if (raw !== undefined) row.raw_json = raw;
  return row;
}

export function normalizeSnapshot(value: unknown): ViewSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new PatchSequenceError("MALFORMED_OP", "快照不是对象");
  }
  const record = value as Record<string, unknown>;
  const rev = typeof record["rev"] === "number" && record["rev"] >= 0 ? record["rev"] : 0;
  const density = isDensity(record["density"]) ? record["density"] : "workbench";
  const rows: Record<string, ViewRow> = {};
  const rawRows = record["rows"];
  if (typeof rawRows === "object" && rawRows !== null && !Array.isArray(rawRows)) {
    for (const [key, row] of Object.entries(rawRows)) {
      const normalized = normalizeRow(row);
      if (normalized) rows[key] = normalized;
    }
  }
  return { rev, density, rows };
}

function normalizePatch(value: unknown): ViewPatch {
  if (typeof value !== "object" || value === null) {
    throw new PatchSequenceError("MALFORMED_OP", "补丁不是对象");
  }
  const record = value as Record<string, unknown>;
  const from = record["from_rev"];
  const to = record["to_rev"];
  if (typeof from !== "number" || typeof to !== "number") {
    throw new PatchSequenceError("MALFORMED_OP", "补丁缺少修订区间");
  }
  const density = isDensity(record["density"]) ? record["density"] : "workbench";
  const rawOps = Array.isArray(record["ops"]) ? record["ops"] : [];
  const ops: ViewOp[] = [];
  for (const rawOp of rawOps) {
    if (typeof rawOp !== "object" || rawOp === null) {
      throw new PatchSequenceError("MALFORMED_OP", "补丁操作不是对象");
    }
    const op = rawOp as Record<string, unknown>;
    if (op["op"] === "remove") {
      if (typeof op["key"] !== "string" || op["key"].trim() === "") {
        throw new PatchSequenceError("MALFORMED_OP", "remove 缺少 key");
      }
      ops.push({ op: "remove", key: op["key"] });
      continue;
    }
    if (op["op"] === "upsert") {
      const row = normalizeRow(op["row"]);
      if (!row) throw new PatchSequenceError("MALFORMED_OP", "upsert 行非法");
      ops.push({ op: "upsert", row });
      continue;
    }
    throw new PatchSequenceError("MALFORMED_OP", "未知补丁操作");
  }
  return { from_rev: from, to_rev: to, density, ops };
}

function cloneRow(row: ViewRow): ViewRow {
  const copy: ViewRow = {
    key: row.key,
    kind: row.kind,
    summary: row.summary,
    updated_rev: row.updated_rev,
  };
  if (row.detail !== undefined) copy.detail = row.detail;
  if (row.raw_json !== undefined) copy.raw_json = row.raw_json;
  return copy;
}

/**
 * 幂等视图状态机。
 * - `to_rev === rev`：同一补丁重放，返回 `duplicate` 且状态不变；
 * - `from_rev !== rev`：乱序，抛出 `PatchSequenceError`，绝不部分合并。
 */
export class ViewStateModel {
  #state: ViewSnapshot;

  constructor(initial?: ViewSnapshot) {
    this.#state = initial ? ViewStateModel.#cloneSnapshot(initial) : { rev: 0, density: "workbench", rows: {} };
  }

  static #cloneSnapshot(snapshot: ViewSnapshot): ViewSnapshot {
    const rows: Record<string, ViewRow> = {};
    for (const [key, row] of Object.entries(snapshot.rows)) {
      rows[key] = cloneRow(row);
    }
    return { rev: snapshot.rev, density: snapshot.density, rows };
  }

  get rev(): number {
    return this.#state.rev;
  }

  get density(): Density {
    return this.#state.density;
  }

  rows(): ReadonlyMap<string, ViewRow> {
    return new Map(Object.entries(this.#state.rows));
  }

  get(key: string): ViewRow | undefined {
    return this.#state.rows[key];
  }

  replace(snapshot: ViewSnapshot): void {
    this.#state = ViewStateModel.#cloneSnapshot(snapshot);
  }

  apply(rawPatch: ViewPatch | unknown): "applied" | "duplicate" {
    const patch = normalizePatch(rawPatch);
    if (patch.to_rev < patch.from_rev) {
      throw new PatchSequenceError(
        "INVALID_REVISION",
        `非法修订区间 from=${patch.from_rev} to=${patch.to_rev}`,
      );
    }
    if (patch.to_rev === this.#state.rev) {
      return "duplicate";
    }
    if (this.#state.rev !== patch.from_rev) {
      throw new PatchSequenceError(
        "OUT_OF_SEQUENCE",
        `补丁序裂：本地 rev=${this.#state.rev}，补丁 from_rev=${patch.from_rev}`,
      );
    }
    for (const op of patch.ops) {
      if (op.op === "upsert") {
        this.#state.rows[op.row.key] = cloneRow(op.row);
      } else {
        delete this.#state.rows[op.key];
      }
    }
    this.#state.rev = patch.to_rev;
    this.#state.density = patch.density;
    return "applied";
  }

  /** 本地密度切换不推进服务端修订号（密度是纯视图关注点）。 */
  setDensity(density: Density): void {
    this.#state.density = density;
  }

  snapshot(): ViewSnapshot {
    return ViewStateModel.#cloneSnapshot(this.#state);
  }

  /** 按当前密度确定性投影（key 升序），隐藏层级字段不下发到 DOM。 */
  visibleRows(): ProjectedRow[] {
    return this.projectedRows(this.#state.density);
  }

  projectedRows(density: Density): ProjectedRow[] {
    return Object.keys(this.#state.rows)
      .sort()
      .flatMap((key) => {
        const row = this.#state.rows[key];
        if (!row) return [];
        const projected: ProjectedRow = {
          key: row.key,
          kind: row.kind,
          summary: row.summary,
          updated_rev: row.updated_rev,
        };
        if (isLayerVisible(density, "detail") && row.detail !== undefined) {
          projected.detail = row.detail;
        }
        if (isLayerVisible(density, "raw") && row.raw_json !== undefined) {
          projected.raw_json = row.raw_json;
        }
        return [projected];
      });
  }
}

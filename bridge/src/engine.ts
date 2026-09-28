// 同步引擎：双侧基线合并。
// 对每个映射，记住「上次写给框架的内容」和「上次在灵魂里看到的内容」，由此分别算出框架侧与灵魂侧各自的改动：
//   条目：结果 = 灵魂当前条目 + 框架新增 − 框架删除；写回框架时按字符上限截取，被截掉的条目仍保留在灵魂里（不算删除）。
//   文本：首次同步时灵魂已有内容则以灵魂为准（重生时不被框架的默认人格覆盖）；之后只有一侧改动取改动方，
//         两侧都改且不同时采用较新（修改时间）的一方。落选版本由调用方先提交进 git 历史再覆盖。
//   全过程无需 agent 参与。
//   文件：日记单向导出 / 其他身体的日记单向镜像；共享笔记逐文件按文本规则双向合并，删除按基线判断。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseEntries, joinEntries } from "../../runtime/src/memory/entries.ts";
import type { Mapping } from "./types.ts";

type TextState = { native: string; soul: string };
type EntryState = { native: string[]; soul: string[] };
export type State = Record<string, any>;

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return undefined; } };
const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
const uniq = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);

export interface Report { changedNative: string[]; changedSoul: string[]; conflicts: { soul: string; loser: string }[] }

/** 在截取上限内按顺序挑出能写回框架的条目。 */
export function fit(entries: string[], limit?: number): string[] {
  if (!limit) return entries;
  const out: string[] = [];
  for (const e of entries) if (joinEntries([...out, e]).length <= limit) out.push(e);
  return out;
}

export function syncEntries(m: Extract<Mapping, { kind: "entries" }>, soulDir: string, st: EntryState | undefined, r: Report): EntryState {
  const nativeText = read(m.native) ?? "";
  const soulFile = path.join(soulDir, m.soul);
  const N = m.read(nativeText), S = parseEntries(read(soulFile) ?? "");
  let result: string[];
  if (!st) result = uniq([...S, ...N]); // 首次接入：两边取并集
  else {
    const added = N.filter((e) => !st.native.includes(e));
    const removed = st.native.filter((e) => !N.includes(e));
    result = uniq([...S, ...added]).filter((e) => !removed.includes(e));
  }
  const soulText = joinEntries(result);
  if (soulText !== joinEntries(S)) { write(soulFile, soulText); r.changedSoul.push(m.soul); }
  const shown = fit(result, m.limit);
  const rendered = m.render(shown, nativeText);
  if (rendered !== nativeText) { write(m.native, rendered); r.changedNative.push(m.native); }
  return { native: shown, soul: result };
}

export function syncText(native: string, soul: string, st: TextState | undefined, r: Report): TextState | undefined {
  const N = read(native), S = read(soul);
  if (N === undefined && S === undefined) return undefined;
  const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const newer = () => (mtime(native) > mtime(soul) ? { result: N!, loser: S! } : { result: S!, loser: N! });
  let result: string, loser: string | undefined;
  if (!st) {
    // 这具身体第一次同步：灵魂里已有内容时以灵魂为准（新装的框架往往带着默认人格，不能覆盖已有的她），
    // 框架原有版本作为落选版本保存进历史。
    if (!S?.trim()) result = N ?? "";
    else { result = S; if (N?.trim() && N !== S) loser = N; }
  } else {
    const nChanged = (N ?? "") !== st.native, sChanged = (S ?? "") !== st.soul;
    if (nChanged && sChanged && N !== S) ({ result, loser } = newer());
    else if (nChanged) result = N ?? "";
    else result = S ?? "";
  }
  if (result !== S) { write(soul, result); r.changedSoul.push(soul); }
  if (result !== N) { write(native, result); r.changedNative.push(native); }
  if (loser !== undefined && loser !== result) r.conflicts.push({ soul, loser });
  return { native: result, soul: result };
}

function syncFilesOut(m: Extract<Mapping, { kind: "files-out" }>, soulDir: string, st: Record<string, string> = {}, r: Report) {
  if (!fs.existsSync(m.nativeDir)) return st;
  for (const f of fs.readdirSync(m.nativeDir)) {
    if (!m.match.test(f)) continue;
    const text = read(path.join(m.nativeDir, f)) ?? "";
    const h = hash(text);
    if (st[f] === h) continue;
    write(path.join(soulDir, m.soulDir, f), text);
    r.changedSoul.push(path.join(m.soulDir, f));
    st[f] = h;
  }
  return st;
}

function syncFilesIn(m: Extract<Mapping, { kind: "files-in" }>, soulDir: string, r: Report) {
  const root = path.join(soulDir, m.soulRoot);
  if (!fs.existsSync(root)) return;
  for (const b of fs.readdirSync(root)) {
    if (b === m.exclude || !fs.statSync(path.join(root, b)).isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, b))) {
      const text = read(path.join(root, b, f)) ?? "";
      const dst = path.join(m.nativeDir, b, f);
      if (read(dst) !== text) { write(dst, text); r.changedNative.push(dst); }
    }
  }
}

function syncFilesBoth(m: Extract<Mapping, { kind: "files-both" }>, soulDir: string, st: Record<string, TextState> = {}, r: Report) {
  const sd = path.join(soulDir, m.soulDir);
  // 笔记是目录树（规范 v2 §3.9，最多 4 层）：按相对路径逐篇同步
  const list = (d: string, rel = "", depth = 1): string[] => !fs.existsSync(path.join(d, rel)) || depth > 4 ? [] :
    fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !e.name.startsWith(".")) return list(d, r, depth + 1);
      return e.isFile() && e.name.endsWith(".md") && !e.name.includes(".incoming") ? [r] : [];
    });
  for (const f of uniq([...list(m.nativeDir), ...list(sd), ...Object.keys(st)])) {
    const n = path.join(m.nativeDir, f), s = path.join(sd, f);
    const hasN = fs.existsSync(n), hasS = fs.existsSync(s), base = st[f];
    if (base && !hasN && hasS && read(s) === base.soul) { fs.rmSync(s); delete st[f]; r.changedSoul.push(s); continue; } // 框架侧删除
    if (base && !hasS && hasN && read(n) === base.native) { fs.rmSync(n); delete st[f]; r.changedNative.push(n); continue; } // 灵魂侧删除
    const next = syncText(n, s, base, r);
    if (next) st[f] = next;
  }
  return st;
}

/** 执行一轮本地合并（不含 git）。 */
export function syncMappings(mappings: Mapping[], soulDir: string, state: State): Report {
  const r: Report = { changedNative: [], changedSoul: [], conflicts: [] };
  for (const m of mappings) {
    if (m.kind === "entries") state[m.id] = syncEntries(m, soulDir, state[m.id], r);
    else if (m.kind === "text") { const s = syncText(m.native, path.join(soulDir, m.soul), state[m.id], r); if (s) state[m.id] = s; }
    else if (m.kind === "files-out") state[m.id] = syncFilesOut(m, soulDir, state[m.id], r);
    else if (m.kind === "files-in") syncFilesIn(m, soulDir, r);
    else if (m.kind === "files-both") state[m.id] = syncFilesBoth(m, soulDir, state[m.id], r);
  }
  return r;
}

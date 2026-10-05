// 同步引擎：双侧基线合并。
// 对每个映射，记住「上次写给框架的内容」和「上次在灵魂里看到的内容」，由此分别算出框架侧与灵魂侧各自的改动：
//   条目：结果 = 灵魂当前条目 + 框架新增 − 框架删除；写回框架时按字符上限截取，被截掉的条目仍保留在灵魂里（不算删除）。
//   文本：首次同步时灵魂已有内容则以灵魂为准（重生时不被框架的默认人格覆盖）；之后只有一侧改动取改动方，
//         两侧都改且不同时采用较新（修改时间）的一方。落选版本由调用方先提交进 git 历史再覆盖。
//   全过程无需 agent 参与。
//   文件：日记单向导出 / 其他身体的日记单向镜像；共享笔记逐文件按文本规则双向合并，删除按基线判断。
//   符号链接一律不跟：两侧读写前先 lstat，是符号链接、或真实路径跑出所属根目录（框架目录 / 灵魂仓库）的条目直接跳过，
//   防止一侧放一个指向 ~/.ssh 之类的链接，把本机文件同步进灵魂仓库或把仓库内容写到别处。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseEntries, joinEntries } from "../../runtime/src/memory/entries.ts";
import type { Mapping } from "./types.ts";

type TextState = { native: string; soul: string };
type EntryState = { native: string[]; soul: string[] };
export type State = Record<string, any>;

/** 真实路径是否在 root 之内（root 不存在时按不在处理）。 */
function inside(root: string, p: string): boolean {
  try { const r = fs.realpathSync(root), q = fs.realpathSync(p); return q === r || q.startsWith(r + path.sep); } catch { return false; }
}
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** 读一个普通文件；是符号链接、不是普通文件、或跑出 root 时视为不存在。 */
function read(f: string, root = path.dirname(f)): string | undefined {
  try {
    if (!fs.lstatSync(f).isFile() || !inside(root, f)) return undefined;
    const fd = fs.openSync(f, fs.constants.O_RDONLY | NOFOLLOW);
    try { return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}
/** f 存在且不是普通文件（符号链接、目录……）。 */
const blocked = (f: string) => { try { return !fs.lstatSync(f).isFile(); } catch { return false; } };
/** 写一个文件：目标是符号链接、或所在目录的真实路径跑出 root 时拒绝（记进 r.skipped），不跟随链接。 */
function write(f: string, s: string, root: string, r?: Report): boolean {
  const dir = path.dirname(f);
  fs.mkdirSync(root, { recursive: true });
  let probe = dir; // 先确认已存在的最近一层祖先在 root 内，再创建缺的目录，免得经链接在别处建目录
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  if (!inside(root, probe) || blocked(f)) { r?.skipped.push(f); return false; }
  fs.mkdirSync(dir, { recursive: true });
  if (!inside(root, dir)) { r?.skipped.push(f); return false; }
  const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW, 0o644);
  try { fs.writeFileSync(fd, s); } finally { fs.closeSync(fd); }
  return true;
}
/** 目录项是否可以安全进入：不是符号链接，且真实路径在 root 内。 */
const safeEntry = (root: string, p: string) => { try { return !fs.lstatSync(p).isSymbolicLink() && inside(root, p); } catch { return false; } };
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
const uniq = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);

export interface Report { changedNative: string[]; changedSoul: string[]; conflicts: { soul: string; loser: string }[]; skipped: string[] /* 因符号链接或越界而跳过的路径 */ }

/** 在截取上限内按顺序挑出能写回框架的条目。 */
export function fit(entries: string[], limit?: number): string[] {
  if (!limit) return entries;
  const out: string[] = [];
  for (const e of entries) if (joinEntries([...out, e]).length <= limit) out.push(e);
  return out;
}

export function syncEntries(m: Extract<Mapping, { kind: "entries" }>, soulDir: string, st: EntryState | undefined, r: Report): EntryState {
  const nRoot = path.dirname(m.native);
  if (blocked(m.native) || blocked(path.join(soulDir, m.soul))) { r.skipped.push(m.native); return st ?? { native: [], soul: [] }; }
  const nativeText = read(m.native, nRoot) ?? "";
  const soulFile = path.join(soulDir, m.soul);
  const N = m.read(nativeText), S = parseEntries(read(soulFile, soulDir) ?? "");
  let result: string[];
  if (!st) result = uniq([...S, ...N]); // 首次接入：两边取并集
  else {
    const added = N.filter((e) => !st.native.includes(e));
    const removed = st.native.filter((e) => !N.includes(e));
    result = uniq([...S, ...added]).filter((e) => !removed.includes(e));
  }
  const soulText = joinEntries(result);
  if (soulText !== joinEntries(S) && write(soulFile, soulText, soulDir, r)) r.changedSoul.push(m.soul);
  const shown = fit(result, m.limit);
  const rendered = m.render(shown, nativeText);
  if (rendered !== nativeText && write(m.native, rendered, nRoot, r)) r.changedNative.push(m.native);
  return { native: shown, soul: result };
}

export function syncText(native: string, soul: string, st: TextState | undefined, r: Report,
  roots = { native: path.dirname(native), soul: path.dirname(soul) }): TextState | undefined {
  if (blocked(native) || blocked(soul)) { r.skipped.push(blocked(native) ? native : soul); return st; } // 任一侧是符号链接：这一项整体不动
  const N = read(native, roots.native), S = read(soul, roots.soul);
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
  if (result !== S && !write(soul, result, roots.soul, r)) return st;
  if (result !== S) r.changedSoul.push(soul);
  if (result !== N && write(native, result, roots.native, r)) r.changedNative.push(native);
  if (loser !== undefined && loser !== result) r.conflicts.push({ soul, loser });
  return { native: result, soul: result };
}

function syncFilesOut(m: Extract<Mapping, { kind: "files-out" }>, soulDir: string, st: Record<string, string> = {}, r: Report) {
  if (!fs.existsSync(m.nativeDir)) return st;
  for (const e of fs.readdirSync(m.nativeDir, { withFileTypes: true })) {
    const f = e.name;
    if (!m.match.test(f)) continue;
    if (!e.isFile()) { if (e.isSymbolicLink()) r.skipped.push(path.join(m.nativeDir, f)); continue; }
    const text = read(path.join(m.nativeDir, f), m.nativeDir);
    if (text === undefined) continue;
    const h = hash(text);
    if (st[f] === h) continue;
    if (!write(path.join(soulDir, m.soulDir, f), text, soulDir, r)) continue;
    r.changedSoul.push(path.join(m.soulDir, f));
    st[f] = h;
  }
  return st;
}

function syncFilesIn(m: Extract<Mapping, { kind: "files-in" }>, soulDir: string, r: Report) {
  const root = path.join(soulDir, m.soulRoot);
  if (!fs.existsSync(root)) return;
  if (!safeEntry(soulDir, root)) { r.skipped.push(root); return; }
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    const b = d.name;
    if (b === m.exclude || !d.isDirectory()) { if (d.isSymbolicLink()) r.skipped.push(path.join(root, b)); continue; }
    for (const e of fs.readdirSync(path.join(root, b), { withFileTypes: true })) {
      const f = e.name;
      if (!e.isFile()) { if (e.isSymbolicLink()) r.skipped.push(path.join(root, b, f)); continue; }
      const text = read(path.join(root, b, f), soulDir);
      if (text === undefined) continue;
      const dst = path.join(m.nativeDir, b, f);
      if (read(dst, m.nativeDir) !== text && write(dst, text, m.nativeDir, r)) r.changedNative.push(dst);
    }
  }
}

function syncFilesBoth(m: Extract<Mapping, { kind: "files-both" }>, soulDir: string, st: Record<string, TextState> = {}, r: Report) {
  const sd = path.join(soulDir, m.soulDir);
  // 笔记是目录树（规范 v2 §3.9，最多 4 层）：按相对路径逐篇同步
  // 符号链接（文件或目录）不列出，也不进入
  const list = (d: string, rel = "", depth = 1): string[] => !fs.existsSync(path.join(d, rel)) || depth > 4 || !safeEntry(d, path.join(d, rel)) ? [] :
    fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !e.name.startsWith(".")) return list(d, r, depth + 1);
      return e.isFile() && e.name.endsWith(".md") && !e.name.includes(".incoming") ? [r] : [];
    });
  for (const f of uniq([...list(m.nativeDir), ...list(sd), ...Object.keys(st)])) {
    const n = path.join(m.nativeDir, f), s = path.join(sd, f);
    if (blocked(n) || blocked(s)) { r.skipped.push(blocked(n) ? n : s); continue; }
    const hasN = fs.existsSync(n), hasS = fs.existsSync(s), base = st[f];
    if (base && !hasN && hasS && read(s, sd) === base.soul) { fs.rmSync(s); delete st[f]; r.changedSoul.push(s); continue; } // 框架侧删除
    if (base && !hasS && hasN && read(n, m.nativeDir) === base.native) { fs.rmSync(n); delete st[f]; r.changedNative.push(n); continue; } // 灵魂侧删除
    const next = syncText(n, s, base, r, { native: m.nativeDir, soul: sd });
    if (next) st[f] = next;
  }
  return st;
}

/** 执行一轮本地合并（不含 git）。 */
export function syncMappings(mappings: Mapping[], soulDir: string, state: State): Report {
  const r: Report = { changedNative: [], changedSoul: [], conflicts: [], skipped: [] };
  for (const m of mappings) {
    if (m.kind === "entries") state[m.id] = syncEntries(m, soulDir, state[m.id], r);
    else if (m.kind === "text") { const s = syncText(m.native, path.join(soulDir, m.soul), state[m.id], r, { native: path.dirname(m.native), soul: soulDir }); if (s) state[m.id] = s; }
    else if (m.kind === "files-out") state[m.id] = syncFilesOut(m, soulDir, state[m.id], r);
    else if (m.kind === "files-in") syncFilesIn(m, soulDir, r);
    else if (m.kind === "files-both") state[m.id] = syncFilesBoth(m, soulDir, state[m.id], r);
  }
  return r;
}

// 灵魂仓库里的路径要在每一种身体上都放得下（规范 v13 §3.13）。Windows 的文件系统比 Linux 严：
//   CON、NUL、COM1 这类保留名（带不带扩展名都不行）、结尾的点与空格、< > : " \ | ? * 与控制字符都不能做文件名；不分大小写，只差大小写的两个路径会互相覆盖。
//   写入时规避（safeSegment）；Windows 身体检出时把放不下的路径排除在工作区之外（windowsUnfit，soul-repo.ts 用 sparse-checkout），并提醒她在别的身体上改名。

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const BAD_CHARS = /[<>:"\\|?*\x00-\x1f]/;

/** 一段路径（目录名或文件名）在 Windows 上为什么放不下；放得下返回 undefined。 */
export function segmentProblem(seg: string): string | undefined {
  if (!seg) return "空的名字";
  if (BAD_CHARS.test(seg)) return "含有 Windows 不允许的字符";
  if (/[. ]$/.test(seg)) return "以点或空格结尾";
  if (RESERVED.test(seg.split(".")[0].trimEnd())) return "是 Windows 的保留名";
  if (/^git~\d+$/i.test(seg) || /^\.git[. ]*$/i.test(seg) && seg !== ".git") return "是 .git 在 NTFS 上的别名";
  return undefined;
}

/** 把一段名字改成哪里都放得下的写法：去掉结尾的点与空格，保留名后面加 _。 */
export function safeSegment(seg: string): string {
  let s = seg.replace(/[. ]+$/, "");
  if (!s) return "untitled";
  if (RESERVED.test(s.split(".")[0])) { const i = s.indexOf("."); s = i < 0 ? `${s}_` : `${s.slice(0, i)}_${s.slice(i)}`; }
  return s;
}

/** 名字（工具名、身体名这类单段标识）是不是 Windows 的保留名。 */
export const reservedName = (name: string) => RESERVED.test(name.split(".")[0]);

/** 一组仓库内的相对路径里，Windows 上放不下的那些：任一段放不下的；以及只差大小写的路径（按排序保留第一个，其余的算放不下）。 */
export function windowsUnfit(files: string[]): { path: string; why: string }[] {
  const out: { path: string; why: string }[] = [];
  const seen = new Map<string, string>();
  for (const f of [...files].sort()) {
    const why = f.split("/").map(segmentProblem).find(Boolean);
    if (why) { out.push({ path: f, why }); continue; }
    const k = f.toLowerCase();
    // 目录也会撞：Notes/a.md 与 notes/b.md 在 Windows 上是同一个目录，按目录前缀比较
    const parts = k.split("/");
    let clash: string | undefined;
    for (let i = 1; i <= parts.length && !clash; i++) {
      const prefix = parts.slice(0, i).join("/"), orig = f.split("/").slice(0, i).join("/");
      const prev = seen.get(prefix);
      if (prev !== undefined && prev !== orig) clash = prev;
      else if (prev === undefined) seen.set(prefix, orig);
    }
    if (clash) out.push({ path: f, why: `与 ${clash} 只差大小写` });
  }
  return out;
}

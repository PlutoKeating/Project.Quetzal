// 时区换算：某个时区里的「年月日时分」与毫秒时刻互换。只用 Intl，没有依赖；夏令时切换的那一刻按 Intl 给的偏移处理。
//   提醒按她所在的时区（config.timezone）排时间，检索的「上周」「昨天」也按这个时区划日子。

/** 某时刻在时区里的各个分量（月份 1–12，星期 0=周日）。 */
export function parts(ts: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday);
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd };
}

/** 时区相对 UTC 的偏移（毫秒）：在那一刻，当地时间 − UTC。 */
export function offset(ts: number, tz: string): number {
  const p = parts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** 时区里的某个钟点 → 毫秒时刻。月份 1–12，日、时可以越界（如 d=0、h=24），按日历进位。 */
export function epoch(y: number, m: number, d: number, h = 0, mi = 0, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offset(guess, tz);
  t = guess - offset(t, tz); // 第二次用算出的时刻的偏移，跨夏令时也对
  return t;
}

/** 时区里那一天 0 点的时刻。 */
export const dayStart = (ts: number, tz: string) => { const p = parts(ts, tz); return epoch(p.y, p.m, p.d, 0, 0, tz); };

/** 是不是合法的 IANA 时区名。 */
export function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * 当地墙上时间 → 毫秒时刻：「2026-10-08T08:00」「2026-10-08 08:00」「2026-10-08」（那天 0 点）。
 * 带时区偏移或 Z 的按原样（ISO）解析。认不出返回 undefined。
 */
export function parseLocal(s: string, tz: string): number | undefined {
  const t = String(s ?? "").trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) { const v = Date.parse(t); return Number.isFinite(v) ? v : undefined; }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(t);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return undefined;
  return epoch(y, mo, d, h, mi, tz);
}

/** 时长 → 毫秒：「30m」「2h」「1h30m」「1d」「90s」「PT30M」「P1D」。认不出返回 undefined。 */
export function parseDuration(s: string): number | undefined {
  const t = String(s ?? "").trim().toLowerCase().replace(/^p(t?)/, "").replace(/t/, "");
  const re = /(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/g;
  let ms = 0, n = 0, rest = t;
  for (const m of t.matchAll(re)) { ms += +m[1] * { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[m[2] as "w"]; n++; rest = rest.replace(m[0], ""); }
  return n && !rest.trim() && ms > 0 ? ms : undefined;
}

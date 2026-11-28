// 时间与数字的写法：阿拉伯数字、固定格式，不随浏览器区域设置变化。

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 两个时刻之间隔了多少个日历日（同一天为 0）。 */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY_MS);
}

/** `2026-11-28` */
export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `09:14` */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `2026-11-28 09:14` */
export function formatDateTime(ms: number): string {
  return `${formatDate(ms)} ${formatClock(ms)}`;
}

/** 给 `<time datetime>` 用的机器可读写法。 */
export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** 「相处第 N 天」里的 N：认识的当天是第 1 天。 */
export function daysTogether(sinceMs: number, nowMs: number): number {
  return Math.max(1, calendarDaysBetween(sinceMs, nowMs) + 1);
}

/** 离现在多久：刚刚、几分钟前、几小时前、昨天、几天前；再远就写日期。 */
export function formatAgo(ms: number, nowMs: number): string {
  const elapsed = nowMs - ms;
  if (elapsed < MINUTE_MS) return "刚刚";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  const days = calendarDaysBetween(ms, nowMs);
  if (days <= 0) return `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  if (days === 1) return "昨天";
  if (days <= 30) return `${days} 天前`;
  return formatDate(ms);
}

/** 时间线里一天的标题：`11 月 28 日 · 今天`。 */
export function formatDayHeading(ms: number, nowMs: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  const base = sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  const days = calendarDaysBetween(ms, nowMs);
  if (days === 0) return `${base} · 今天`;
  if (days === 1) return `${base} · 昨天`;
  return base;
}

/** 一组时刻跨了多少天（同一天算 1 天；空组为 0）。 */
export function spanDays(times: readonly number[]): number {
  if (times.length === 0) return 0;
  return calendarDaysBetween(Math.min(...times), Math.max(...times)) + 1;
}

/** 等宽两位编号：`01`、`02`。 */
export function ordinal(index: number): string {
  return pad2(index + 1);
}

/** 列表里的一行摘要；全文在选中之后看。 */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

/** 0–1 的权重写成 0–100 的整数。 */
export function percent(weight: number): number {
  return Math.round(Math.min(1, Math.max(0, weight)) * 100);
}

// 把路径等不可信字符串安全地写进 shell 命令、systemd 单元、launchd plist 与 crontab（路径里可能有空格、引号、%、$）。
// 换行一律拒绝：这几种格式都按行解析，换行会注入新的一行。

function noNewline(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error(`拒绝写入含换行或 NUL 的参数：${JSON.stringify(s)}`);
  return s;
}

/** POSIX shell 单引号转义：不需要时原样返回（与旧的钩子命令保持一致，已批准的 Hermes 钩子不失效）。 */
export function shQuote(s: string): string {
  noNewline(s);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
export const shJoin = (args: string[]) => args.map(shQuote).join(" ");

/** systemd 单元里的一个参数：双引号 + C 风格转义；% 是说明符、$ 是变量展开，都要加倍。 */
export function systemdQuote(s: string): string {
  noNewline(s);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}
/** systemd 单元里的自由文本（Description）：去掉换行，% 加倍。 */
export const systemdText = (s: string) => s.replace(/[\r\n\0]+/g, " ").replace(/%/g, "%%");

/** XML 文本 / 属性转义（launchd plist）。 */
export function xmlEscape(s: string): string {
  noNewline(s);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** crontab 一行里的一个参数：先按 shell 单引号转义，再把 % 写成 \%（cron 把未转义的 % 当作换行）。 */
export function cronQuote(s: string): string {
  return `'${noNewline(s).replace(/'/g, `'\\''`)}'`.replace(/%/g, "\\%");
}

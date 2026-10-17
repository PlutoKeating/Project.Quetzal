// macOS 的命令沙箱边界：交给 sandbox-runtime（Anthropic，Apache-2.0，锁定 0.0.78）的 macOS 后端，它为每条命令生成 Seatbelt 配置，
// 经系统自带的 /usr/bin/sandbox-exec 运行。这里只算「哪些路径看不见 / 能写 / 不能写」，与 Linux 的 bwrap 等价：
//   - 看不见：密钥目录（secrets/）、浏览器的配置目录（网页控制台的令牌、各网站的 Cookie）、钥匙串文件；
//   - QUETZAL_HOME 整体只读（含 data/ 与整个灵魂，写入经宿主工具）；
//   - 能写：用户主目录（QUETZAL_HOME 除外）、临时目录与部署者在 config.sandbox.share 里列出的目录；
//     QUETZAL_HOME 特殊地等于主目录或根目录时，只有独立工作区（QUETZAL_WORKSPACE，缺省 ~/Quetzal）可写；
//   - 改了会在沙箱外执行的东西只读：shell 启动文件、~/Library/LaunchAgents（launchd 用户代理）、~/.ssh、git 配置、~/.local/bin 等。
//   sandbox-runtime 的 Seatbelt 配置本身缺省拒绝：只放行少数系统服务（没有 Apple 事件，osascript 控制不了别的应用），网络只能连它在
//   运行基座进程里开的代理（经 HTTP_PROXY / ALL_PROXY 等环境变量），代理拒绝这台机器自己的地址（见 sandbox.ts 的 selfAddress）。
import path from "node:path";

export interface MacFsInput {
  home: string;            // QUETZAL_HOME（真实路径）
  homeRaw?: string;        // QUETZAL_HOME 的原始写法（与真实路径不同时两种都写上）
  data: string; soul: string; secrets: string;
  userHome: string;        // 用户主目录
  workspace?: string;      // QUETZAL_HOME 特殊（等于主目录或根目录）时的独立工作区；平时不给
  tmp: string[];           // 临时目录（/tmp、/private/tmp、TMPDIR 与它的真实路径）
  share?: string[];        // config.sandbox.share：部署者额外开放写入的绝对路径
  exists?: (p: string) => boolean;
}

/** 用户主目录里改了会在沙箱外执行（或泄露凭据）的东西：只读。macOS 比 Linux 多了 launchd 用户代理与登录项。 */
export const MAC_USER_READONLY = [
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
  ".config/fish", ".config/git", ".gitconfig", ".ssh", ".local/bin",
  "Library/LaunchAgents", "Library/Application Support/com.apple.backgroundtaskmanagementagent", "Library/Preferences/com.apple.loginitems.plist",
  "Library/Keychains",
];
/** 浏览器的配置目录（令牌与 Cookie）与钥匙串文件：沙箱里读不到。 */
export const MAC_HIDDEN = [
  "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge", "Library/Application Support/Vivaldi", "Library/Application Support/com.operasoftware.Opera",
  "Library/Application Support/Firefox", "Library/Safari", "Library/Cookies", "Library/Containers/com.apple.Safari", "Library/Keychains",
];

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);

/** sandbox-runtime 的 filesystem 配置（macOS 语义：读缺省放行、denyRead 拒绝；写缺省拒绝、allowWrite 放行、denyWrite 在放行里再拒绝）。 */
export function macFilesystem(i: MacFsInput): { denyRead: string[]; allowWrite: string[]; denyWrite: string[] } {
  const exists = i.exists ?? (() => true);
  const homes = [...new Set([i.home, i.homeRaw ?? i.home])];
  const user = (rel: string[]) => rel.map((r) => path.join(i.userHome, r)).filter(exists);
  const share = (i.share ?? []).filter((p) => path.isAbsolute(p) && !homes.some((h) => overlaps(p, h)) && ![i.data, i.soul, i.secrets].some((d) => overlaps(p, d)));
  const allowWrite = [...new Set([...(i.workspace ? [i.workspace] : [i.userHome]), ...i.tmp, ...share])];
  // 特殊家目录：主目录（或根目录）整体不开放写入，只开放工作区；但工作区不能落在运行数据里
  const denyWrite = [...new Set([...(i.workspace ? [i.data, i.soul, i.secrets] : homes), i.data, i.soul, ...user(MAC_USER_READONLY)])];
  const denyRead = [...new Set([i.secrets, ...user(MAC_HIDDEN)])];
  return { denyRead, allowWrite, denyWrite };
}

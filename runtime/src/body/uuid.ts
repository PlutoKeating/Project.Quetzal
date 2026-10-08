// 这具身体的 uuid：绑定到设备，重装 Quetzal、重新生成节点密钥都不变。工具的 body 参数用它指一具身体（mind/body-files.ts）。
//   - 来源：适配器的 deviceId()（Linux 的 machine-id、Windows 的 MachineGuid、安卓 App 的 ANDROID_ID……）。核心不碰设备。
//   - 派生：原始设备标识是敏感信息，不出现在日志、审计、灵魂仓库、网状层消息与系统提示里；只用它的哈希：
//     sha256(命名空间串 + 原始标识) 取前 16 字节，按 RFC 9562 设 version 8 与 variant 位。
//   - 持久化：存进 QUETZAL_HOME/state/body-uuid（JSON {uuid, source}）。设备派生的一经存下永不再变；家目录没了（重装）就从设备标识
//     重新算出同一个值。设备标识暂时取不到时（安卓 App 的身体接口还没起来、一时读不到文件）先用随机的 v4，之后每次启动、
//     以及启动后隔一会儿再试，取到了就换成设备派生的值并固定下来。部署者手动写的 {uuid, source: "manual"} 也不再变。
//   - 它不是密码学身份：其他身体以灵魂仓库的身体登记（bodies/<身体>.json 的 uuid，规范 v14）为准，再核对对方自报的一致。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "../config.ts";

const NAMESPACE = "quetzal-body-uuid/1\n";
/** 合法的身体 uuid：派生的 v8，或取不到设备标识时随机的 v4。 */
export const BODY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 由原始设备标识派生 uuid（RFC 9562 version 8）。 */
export function deviceUuid(raw: string): string {
  const b = crypto.createHash("sha256").update(NAMESPACE + raw).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // version 8
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 适配器给的标识能不能用：有内容（格式由各适配器按自己平台的标识核对，见 adapters/*；这里不按长短去猜）。512 字符是读取上限。 */
const usable = (raw: unknown): raw is string => typeof raw === "string" && raw.trim().length > 0 && raw.trim().length <= 512;

const file = () => path.join(paths.state, "body-uuid");
/** manual：部署者手动指定的（例如同一台设备上两份运行基座撞了 uuid 时给其中一份换一个），和设备派生的一样不再变。 */
type Source = "device" | "random" | "manual";
let cached: { uuid: string; source: Source } | undefined;

/** 读存下的 uuid：JSON {uuid, source}；兼容早先的纯文本（按版本位判断来源：v8 是设备派生的，v4 是随机的）。 */
function load(): { uuid: string; source: Source } | undefined {
  let text: string;
  try { text = fs.readFileSync(file(), "utf8").trim(); } catch { return undefined; }
  let uuid = text.toLowerCase(), source: unknown;
  try { const j = JSON.parse(text); if (j && typeof j === "object") { uuid = String(j.uuid ?? "").toLowerCase(); source = j.source; } } catch {}
  if (!BODY_UUID.test(uuid)) return undefined;
  return { uuid, source: source === "device" || source === "random" || source === "manual" ? source : uuid[14] === "8" ? "device" : "random" };
}
function save(v: { uuid: string; source: Source }) {
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(v) + "\n");
  cached = v;
}

/** 这具身体的 uuid（启动时由 ensureBodyUuid 定下；还没定下时为 undefined）。 */
export function bodyUuid(): string | undefined {
  return (cached ??= load())?.uuid;
}

/**
 * 启动时调用（随机来源时之后还会重试）：设备派生的一经存下永不再变；随机的只是暂用——每次都再试 deviceId()，
 * 取到了就换成设备派生的值并存盘（身体登记在下一次同步时随之更新，其他身体与系统提示看到新值）。都没有时随机生成一个 v4 存下。
 * source：stored（设备派生、早已存下）/ device（这次由设备标识派生，包括从随机升级）/ random（取不到设备标识，用随机值）。
 */
export async function ensureBodyUuid(deviceId?: () => Promise<string | undefined>): Promise<{ uuid: string; source: "stored" | "device" | "random" }> {
  const have = (cached ??= load());
  if (have?.source === "device" || have?.source === "manual") return { uuid: have.uuid, source: "stored" };
  let raw: unknown;
  try { raw = await deviceId?.(); } catch { raw = undefined; }
  if (usable(raw)) { const uuid = deviceUuid((raw as string).trim()); save({ uuid, source: "device" }); return { uuid, source: "device" }; }
  if (have) return { uuid: have.uuid, source: "random" };
  const uuid = crypto.randomUUID();
  save({ uuid, source: "random" });
  return { uuid, source: "random" };
}

/** 测试用：忘掉缓存。 */
export function resetBodyUuid() { cached = undefined; }

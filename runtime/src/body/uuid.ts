// 这具身体的 uuid：绑定到设备，重装 Quetzal、重新生成节点密钥都不变。工具的 body 参数用它指一具身体（mind/body-files.ts）。
//   - 来源：适配器的 deviceId()（Linux 的 machine-id、Windows 的 MachineGuid、安卓 App 的 ANDROID_ID……）。核心不碰设备。
//   - 派生：原始设备标识是敏感信息，不出现在日志、审计、灵魂仓库、网状层消息与系统提示里；只用它的哈希：
//     sha256(命名空间串 + 原始标识) 取前 16 字节，按 RFC 9562 设 version 8 与 variant 位。
//   - 持久化：第一次算出后存进 QUETZAL_HOME/state/body-uuid，之后以这份为准。
//     家目录没了（重装）就从设备标识重新算出同一个值；设备标识取不到时随机生成一个 v4，只在家目录存在期间不变。
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

/** 适配器给的标识能不能用：至少 8 个字符、不是同一个字符重复（有的设备返回全 0）。 */
const usable = (raw: unknown): raw is string => typeof raw === "string" && raw.trim().length >= 8 && raw.trim().length <= 512 && !/^(.)\1*$/.test(raw.trim());

const file = () => path.join(paths.state, "body-uuid");
let cached: string | undefined;

/** 这具身体的 uuid（启动时由 ensureBodyUuid 定下；还没定下时为 undefined）。 */
export function bodyUuid(): string | undefined {
  if (cached) return cached;
  try { const v = fs.readFileSync(file(), "utf8").trim().toLowerCase(); if (BODY_UUID.test(v)) cached = v; } catch {}
  return cached;
}

/** 启动时调用：已经存过的为准；没有就从设备标识派生，取不到就随机生成，存进 state/body-uuid。 */
export async function ensureBodyUuid(deviceId?: () => Promise<string | undefined>): Promise<{ uuid: string; source: "stored" | "device" | "random" }> {
  const have = bodyUuid();
  if (have) return { uuid: have, source: "stored" };
  let raw: unknown;
  try { raw = await deviceId?.(); } catch { raw = undefined; }
  const fromDevice = usable(raw);
  const uuid = fromDevice ? deviceUuid((raw as string).trim()) : crypto.randomUUID();
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(file(), uuid + "\n");
  cached = uuid;
  return { uuid, source: fromDevice ? "device" : "random" };
}

/** 测试用：忘掉缓存。 */
export function resetBodyUuid() { cached = undefined; }

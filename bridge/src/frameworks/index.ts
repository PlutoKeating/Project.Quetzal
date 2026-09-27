import fs from "node:fs";
import { hermes } from "./hermes.ts";
import { openclaw } from "./openclaw.ts";
import type { Framework } from "../types.ts";

/** 已支持的框架。新增框架只需实现 Framework 接口并登记在这里。 */
export const frameworks: Record<string, Framework> = { hermes, openclaw };

/** 探测本机装了哪些框架。 */
export const detect = (): string[] => Object.values(frameworks).filter((f) => fs.existsSync(f.defaultHome())).map((f) => f.id);

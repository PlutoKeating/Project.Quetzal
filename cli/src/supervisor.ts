// 这台机器的守护者：Linux 是 systemd 用户服务（service.ts），macOS 是 launchd 用户代理（launchd.ts）。两者导出同一组函数。
import * as systemd from "./service.ts";
import * as launchd from "./launchd.ts";

export const isMac = process.platform === "darwin";
export const svc = isMac ? launchd : systemd;
/** 运行基座的身体适配器文件名（版本目录里）。 */
export const adapterFile = isMac ? "macos.mjs" : "linux.mjs";

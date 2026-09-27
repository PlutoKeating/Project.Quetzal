// 一轮完整同步：拉取远端 → 本地双侧合并 → 冲突落选版本先入历史 → 推送。整个过程无需 agent 参与。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SoulRepo } from "../../runtime/src/memory/soul-repo.ts";
import { syncMappings, type Report } from "./engine.ts";
import { frameworks } from "./frameworks/index.ts";
import { keyPath, repoDir, loadState, saveState, dirOf } from "./config.ts";
import type { BridgeConfig } from "./types.ts";

export const VERSION = "0.1.0";

export function repoOf(c: BridgeConfig) {
  const who = () => { try { return JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "agent.json"), "utf8")); } catch { return {}; } };
  return new SoulRepo({
    dir: repoDir(c.agent), remote: c.remote, branch: c.branch, body: c.body, sshKey: keyPath(c.agent),
    author: () => ({ name: `${who().displayName ?? c.agent} (${c.body})`, email: `${who().name ?? c.agent}@${c.body}.local` }),
    bodyInfo: () => ({ kind: "bridge", framework: c.framework, bridge: VERSION, host: os.hostname() }),
    log: (m) => console.error(`[soul-bridge] ${m}`),
  });
}

/** 首次接入时，仓库里还没有身份文件则创建一份（名字取自参数或框架的人格文件）。 */
export function ensureIdentity(c: BridgeConfig, displayName?: string) {
  const f = path.join(repoDir(c.agent), "agent.json");
  if (fs.existsSync(f)) return;
  const fw = frameworks[c.framework];
  const name = displayName ?? fw.guessName?.(c.home) ?? c.agent;
  fs.writeFileSync(f, JSON.stringify({
    id: crypto.randomUUID(), name: c.agent.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "agent", displayName: name,
    pronouns: "", description: "", color: "#7C6CF2", language: "zh-CN", createdAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

let running: Promise<Report> | undefined;
export function syncOnce(c: BridgeConfig): Promise<Report> {
  running = (running ?? Promise.resolve()).catch(() => {}).then(async () => {
    const repo = repoOf(c);
    await repo.ensure();
    await repo.pull();
    const fw = frameworks[c.framework];
    const state = loadState(c.agent);
    const report = syncMappings(fw.mappings(c.home, c.body), repoDir(c.agent), state);
    for (const x of report.conflicts) { // 落选版本先提交进历史，再恢复胜出版本
      const winner = fs.readFileSync(x.soul, "utf8");
      fs.writeFileSync(x.soul, x.loser);
      await repo.commit(`保存 ${path.basename(x.soul)} 的另一版本（冲突自动解决，已采用较新的版本）`);
      fs.writeFileSync(x.soul, winner);
    }
    saveState(c.agent, state);
    await repo.push(report.changedSoul.length ? `同步 ${fw.label} 的变更` : "同步");
    if (report.changedNative.length) await fw.afterExport?.(c.home).catch(() => {});
    fs.writeFileSync(path.join(dirOf(c.agent), "last-sync.json"), JSON.stringify({ at: new Date().toISOString(), ...report, error: repo.status.lastError }, null, 2));
    return report;
  });
  return running;
}

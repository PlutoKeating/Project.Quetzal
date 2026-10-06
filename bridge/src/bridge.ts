// 一轮完整同步：拉取远端 → 本地双侧合并 → 冲突落选版本先入历史 → 推送。整个过程无需 agent 参与。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SoulRepo } from "../../runtime/src/memory/soul-repo.ts";
import { syncMappings, type Report } from "./engine.ts";
import { frameworks } from "./frameworks/index.ts";
import { keyPath, repoDir, loadState, saveState, dirOf } from "./config.ts";
import { meshKeyIfAny } from "./mesh.ts";
import type { BridgeConfig } from "./types.ts";

export const VERSION = "0.2.0";

/** 灵魂仓库对象。displayName 仅在仓库还没有身份时用于生成第一份身份（规范 §3.5、§4）。 */
export function repoOf(c: BridgeConfig, displayName?: string) {
  const who = () => { try { return JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "agent.json"), "utf8")); } catch { return {}; } };
  return new SoulRepo({
    dir: repoDir(c.agent), remote: c.remote, branch: c.branch, body: c.body, sshKey: keyPath(c.agent),
    seedIdentity: () => newIdentity(c, displayName),
    seedSoul: (n) => nativeSoul(c) ?? `# ${n}\n`, // 新仓库的人格以框架现有人格为准，避免种子覆盖它
    author: () => ({ name: `${who().displayName ?? c.agent} (${c.body})`, email: `${who().name ?? c.agent}@${c.body}.local` }),
    bodyInfo: () => { const meshKey = meshKeyIfAny(c.agent); return { kind: "bridge", framework: c.framework, bridge: VERSION, host: os.hostname(), ...(meshKey ? { meshKey } : {}) }; }, // meshKey：绑定过网状层才有（规范 v8）
    log: (m) => console.error(`[soul-bridge] ${m}`),
  });
}

/** 框架现有的人格文本（没有则 undefined）。 */
function nativeSoul(c: BridgeConfig): string | undefined {
  const m = frameworks[c.framework].mappings(c.home, c.body).find((x) => x.id === "soul");
  try { return m && "native" in m ? fs.readFileSync(m.native, "utf8") : undefined; } catch { return undefined; }
}

/** 仓库还没有身份时生成第一份（名字取自参数或框架的人格文件；两者都没有时为种子身份，遇到其他身体的身份会让位）。 */
function newIdentity(c: BridgeConfig, displayName?: string) {
  const guessed = displayName ?? frameworks[c.framework].guessName?.(c.home);
  return {
    id: c.agentId ?? crypto.randomUUID(), name: c.agent.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "agent", displayName: guessed ?? c.agent,
    pronouns: "", description: "", color: "#F0A35E", language: "zh-CN", createdAt: new Date().toISOString(),
    ...(guessed ? {} : { seed: true }),
  };
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

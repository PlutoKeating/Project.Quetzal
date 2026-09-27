// 桥接配置：~/.agent-soul/<agent>/{config.json, repo/, state.json, id_ed25519}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeConfig } from "./types.ts";

export const ROOT = process.env.SOUL_BRIDGE_HOME ?? path.join(os.homedir(), ".agent-soul");
export const dirOf = (agent: string) => path.join(ROOT, agent);
export const repoDir = (agent: string) => path.join(dirOf(agent), "repo");
export const keyPath = (agent: string) => path.join(dirOf(agent), "id_ed25519");

export function listAgents(): string[] {
  return fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((a) => fs.existsSync(path.join(dirOf(a), "config.json"))) : [];
}
export function loadConfig(agent?: string): BridgeConfig {
  const all = listAgents();
  const a = agent ?? (all.length === 1 ? all[0] : undefined);
  if (!a) throw new Error(all.length ? `请用 --agent 指定：${all.join("、")}` : "还没有接入任何 agent，请先运行 init");
  return JSON.parse(fs.readFileSync(path.join(dirOf(a), "config.json"), "utf8"));
}
export function saveConfig(c: BridgeConfig) {
  fs.mkdirSync(dirOf(c.agent), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dirOf(c.agent), "config.json"), JSON.stringify(c, null, 2) + "\n");
}
export function loadState(agent: string): Record<string, any> { try { return JSON.parse(fs.readFileSync(path.join(dirOf(agent), "state.json"), "utf8")); } catch { return {}; } }
export function saveState(agent: string, s: Record<string, any>) { fs.writeFileSync(path.join(dirOf(agent), "state.json"), JSON.stringify(s)); }

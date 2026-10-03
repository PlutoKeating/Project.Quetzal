// Agent 身份：每个 agent 的元数据，存放在灵魂目录的 agent.json，随灵魂仓库在所有身体间同步。
// 运行基座与控制台不写死任何名字，一切称呼、配色都来自这里。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "../config.ts";

export interface AgentIdentity {
  id: string; // 全局唯一：用于防止把不同 agent 的灵魂仓库混在一起
  name: string; // 标识符（小写字母、数字、连字符）
  displayName: string; // 显示名
  pronouns: string; // 代词（可空）
  description: string; // 一句话简介
  color: string; // 主题色（#RRGGBB）
  language: string; // 偏好语言（BCP 47），仅作提示
  createdAt: string;
  seed?: boolean; // true = 自动生成、尚未被任何人或同步修改过
}

const file = () => path.join(paths.soul, "agent.json");

export function defaultIdentity(): AgentIdentity {
  return {
    id: crypto.randomUUID(), name: "agent", displayName: "未命名的 Agent", pronouns: "", description: "",
    color: "#F0A35E", language: "zh-CN", createdAt: new Date().toISOString(), seed: true,
  };
}

export function identity(): AgentIdentity {
  try {
    const { seed, ...defaults } = defaultIdentity();
    return { ...defaults, ...JSON.parse(fs.readFileSync(file(), "utf8")) }; // seed 只以文件中的为准
  } catch {
    const d = defaultIdentity();
    fs.mkdirSync(paths.soul, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(d, null, 2) + "\n");
    return d;
  }
}

export function setIdentity(patch: Partial<AgentIdentity>): AgentIdentity {
  const cur = identity();
  const next: AgentIdentity = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt };
  delete next.seed;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(next.name)) throw new Error("name 只能包含小写字母、数字和连字符");
  if (!/^#[0-9a-fA-F]{6}$/.test(next.color)) throw new Error("color 必须是 #RRGGBB");
  if (!next.displayName.trim()) throw new Error("显示名不能为空");
  fs.writeFileSync(file(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export const displayName = () => identity().displayName;

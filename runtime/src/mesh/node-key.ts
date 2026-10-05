// 这具身体的节点密钥（第一次用到时生成，secrets/mesh_ed25519）。单独成模块：灵魂同步要把公钥写进身体登记，又不该依赖整个网状层。
import path from "node:path";
import { paths } from "../config.ts";
import { loadNodeKey, type NodeKey } from "./identity.ts";

let key: NodeKey | undefined;
export function nodeKey(): NodeKey { return (key ??= loadNodeKey(path.join(paths.secrets, "mesh_ed25519"))); }

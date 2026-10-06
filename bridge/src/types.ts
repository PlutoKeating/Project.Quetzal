// 映射：框架原生文件与灵魂仓库文件之间的对应关系。
export type Mapping =
  | { id: string; kind: "text"; native: string; soul: string } // 整段文本（人格）
  | {
      id: string; kind: "entries"; native: string; soul: string; // 条目（常驻记忆）
      limit?: number; // 写回框架时的字符上限（超出的条目只是暂不写回，不视为删除）
      read: (nativeText: string) => string[];
      render: (entries: string[], nativeText: string) => string;
    }
  | { id: string; kind: "files-out"; nativeDir: string; soulDir: string; match: RegExp } // 框架 → 灵魂（本身体的日记）
  | { id: string; kind: "files-in"; soulRoot: string; nativeDir: string; exclude: string } // 灵魂 → 框架（其他身体的日记，只读镜像）
  | { id: string; kind: "files-both"; nativeDir: string; soulDir: string }; // 双向（共享笔记）

export interface Framework {
  id: string;
  label: string;
  defaultHome(): string;
  mappings(home: string, body: string): Mapping[];
  /** 安装框架钩子（会话结束、记忆写入后调用 sync）。返回说明文字。 */
  installHooks(home: string, syncCommand: string[]): Promise<string>;
  removeHooks(home: string): Promise<void>;
  /** 灵魂内容写回框架后需要做的事（如重建索引）。 */
  afterExport?(home: string): Promise<void>;
  /** 从框架原生人格文件猜测显示名（首次接入时用）。 */
  guessName?(home: string): string | undefined;
}

export interface BridgeConfig {
  agent: string; // 本机上这个 agent 的标识（目录名）
  framework: string;
  home: string; // 框架家目录 / 工作区
  remote: string;
  branch: string;
  body: string; // 这具身体的名字
  poll: number; // 守护模式下拉取远端的间隔（秒，0 = 只在本地变化与钩子触发时同步）
  agentId?: string; // 同步服务批准时给的 agent id（新建的 agent 由这里决定 agent.json 的 id）
}

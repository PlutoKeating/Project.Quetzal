# bridge · soul-bridge

把 Hermes Agent / OpenClaw 接入 agent 的灵魂仓库：独立、可随时插拔、全自动双向同步。设计与协议见 [../../docs/SOUL_SYNC.md](../../docs/SOUL_SYNC.md)。

- 运行环境：Node.js 22.18+（直接运行 TypeScript 源码，无需构建、无第三方依赖）与 git。
- 安装方式：把 [技能](../skills/soul-bridge/SKILL.md) 交给框架里的 agent，由它代为执行；用户不需要使用命令行。
- 测试：`npm test`（引擎单元测试 + 通过真实 CLI 让 Hermes 与 OpenClaw 共享同一个 agent 的端到端测试）。

| 命令 | 作用 |
|---|---|
| `init --framework hermes\|openclaw --repo <地址> [--agent] [--home] [--body] [--name] [--poll 300]` | 接入：生成部署密钥、克隆或初始化仓库、导入现有人格与记忆、安装钩子与后台服务 |
| `sync` | 立即同步一次（框架钩子调用） |
| `run` | 前台守护：监视框架文件（事件驱动）+ 定期拉取远端 |
| `attach` | 重新安装钩子与服务 |
| `status` | 配置、最近一次同步结果、公钥 |
| `detach [--purge]` | 拔出：移除钩子与服务，框架文件保持原样 |

本地数据：`~/.agent-soul/<agent>/`（`config.json`、`repo/`、`state.json` 基线、`id_ed25519` 部署密钥、`last-sync.json`、`bridge.log`）。

```
src/
├── cli.ts                命令行入口
├── bridge.ts             一轮同步：拉取 → 双侧基线合并 → 冲突落选版本入历史 → 推送
├── engine.ts             双侧基线合并（条目 / 文本 / 文件）
├── service.ts            守护（watch + 拉取）、systemd 用户服务 / launchd 代理
├── config.ts             本地配置与基线
├── types.ts              Mapping 与 Framework 接口
└── frameworks/           hermes.ts · openclaw.ts · index.ts（登记）
```

git 同步协议与冲突规则复用运行基座的 `runtime/src/memory/soul-repo.ts` 与 `entries.ts`，两边行为一致。

# 独立引擎第一切片：变更与验证

日期：2026-10-14；实现起点 `f4f93c4`。本次遵循避免大范围重构的要求，只提取通用协议和真实模型—工具循环。初始实现快照继续保存在 [BASELINE.md](BASELINE.md)。

## 1. 已实现范围

- 新增根级 `engine/`，公开 `runTurn()`、通用模型消息 / 工具类型及宿主端口协议；引擎源码不导入 runtime，没有第三方运行时依赖。
- `runtime/src/mind/brain.ts` 的私有 `loop()` 改为宿主适配，将模型调用、工具执行、Session、输入补充、停止判断、脱敏与记录注入引擎。对话、思考、做梦和子 agent 的真实执行都经过此入口。
- `runtime/src/providers/types.ts` 重导出通用协议，原有供应商调用者保留导入路径；供应商配置和 ProviderError 留在 runtime。
- Session 生命周期、上下文、记忆、身体、心脏、工具闸门、通道和 mesh 留在原目录。不改变现有预算、压缩、权限或调度策略。
- runtime 的 `npm test` 包含引擎测试，`npm run build` 增加引擎独立类型检查；CI 路径匹配新增 `engine/**`，Windows 串行测试入口也包含引擎测试。

没有新增 MCP / TUI 代码或引入论文算法；它们已有独立工作包，后续按小切片实施。

## 2. 构建与依赖

engine 独立测试直接用 Node.js 运行 TypeScript；类型检查和构建复用 runtime 锁定的 TypeScript、esbuild 和 Node 类型。这个开发工具链依赖已在模块文档明确，不等同引擎实现依赖 runtime。

engine 构建产物为 `dist/index.mjs` 与 sourcemap，已忽略；runtime 继续从 `main.ts` 打包源码，发布产物名字和 App / CLI 打包路径不变。本次没有增加依赖；已核对 `runtime/package.json` 的三类依赖与 `package-lock.json` 根元数据一致，锁文件无需内容变化。

## 3. 审查与本地验证

本轮环境：Linux，Node.js v24.16.0。使用合成模型 / 工具和本地模拟供应商，未使用真实模型 Key、生产灵魂或外部 MCP 服务。

| 检查 | 结果与范围 |
|---|---|
| 独立引擎测试 | 14 项通过；覆盖真实循环、结果裁剪、失败 / 拒绝、finish、空输出、插话、打断、停止、交接、动态输出上限、并发状态隔离及无 runtime 导入 |
| engine 独立类型检查 / 构建 / 产物导入 | 通过；构建产物可导入，无需启动宿主 |
| runtime 定向回归 | context、sessions、agents、walls 共 36 项通过 |
| runtime 类型检查与完整构建 | 通过；保持原有主程序、平台适配器和辅助产物 |
| 全量 `npm test` | 共 320 项：311 通过，2 失败，7 跳过；失败位于 coordinator 与 mesh-lan 的真实 WebRTC 场景，不能报告全量通过 |

全量运行结束后对两个失败文件进行串行定向复测，并从原始提交 `f4f93c4` 导出 runtime 到仓库外临时目录，复用相同依赖运行同样的两个文件。新旧版本均为 5 项中 4 通过、1 失败：coordinator 在定向复测通过；mesh-lan 都在等待局域网地址表落盘处超时。因此该 mesh-lan 失败在未提取引擎的原始提交也存在；coordinator 的全量失败尚未确定根因，不能据定向通过就报告全量通过。本轮不改动这些未涉及的网络实现或测试。新增静态依赖边界测试另由完整的 14 项 engine 独立测试覆盖。

主要命令：

```bash
npm test --prefix engine
npm run typecheck --prefix engine
npm run build --prefix engine
npm test --prefix runtime
npm run build --prefix runtime
```

只读审查逐分支对照原循环，确认保留工具快照、串行执行、finish 后同响应后续工具执行、原始取消分类、空回复提醒、动态读取输出上限和身体交接。审查发现并修正：engine 变更遗漏 CI 触发 / 测试，finishTool 类型允许与实际保留名不一致。新的 `FinishTool.name` 限定 `finish`，JavaScript 非法配置在模型请求前失败；没有提供 schema 时仍保留旧循环识别 finish 的兼容行为。

## 4. 证据限制

当前只证明独立执行切片与本地宿主兼容性；完整会话服务、可替换上下文 / 记忆接口、MCP、TUI、执行预算和论文策略尚未完成。开发工具链仍复用仓库内 runtime 安装的依赖，没有配置引擎单独 npm 发布流程。

未执行 Windows / Android 真机、Flutter 构建、真实模型 / 语音、跨设备部署或远程发布。CI 配置已更新，但本地配置检查不等于远端 CI 已运行。测试取消只证明循环与注入信号的行为，不证明外部副作用被撤销。

# DeepSeek Harness 插件：Quetzalcoatl

这是 `qz connect` 接上 DeepSeek Harness（`dsh`）时写出的插件与补丁模板，内嵌进 `qz` 二进制，不需要手工拷贝。

- 插件 `quetzalcoatl/index.ts` 写到 `QUETZALCOATL_HOME/hosts/dsh/plugin/index.ts`，dsh 按绝对路径加载（入口是 TypeScript，由 Node 直接运行），不经 pnpm 安装。
- `cordis.patch.yml` 是一段带首尾标记的插入，追加到 dsh 的用户层补丁 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/`）末尾，登记这个插件与 `@deepseek-ai/dsh-mcp-client` → `qz mcp --host dsh`。用户层补丁对所有 profile 生效。
- 撤下（`qz connect --undo`）删掉标记之间的那一段与插件；补丁里你自己写的部分一字不动，文件若是我们建的、删完只剩空白就整个删掉。

## 它做什么

插件里不写逻辑，每个挂点都把 dsh 的事件改写成 `qz hook --host dsh` 认得的样子：

| dsh 挂点 | 交给 qz 的事件 | 作用 |
| --- | --- | --- |
| 会话里第一次 `agent/pre-step`（有你亲手打的字） | `SessionStart` | 取回核心，作为系统提示里的一节（`systemPrompt.section`） |
| 每次 `agent/pre-step` | `UserPromptSubmit` | 认出你亲口说的「记住、纠正、别再提、忘掉」，取回相关往事，作为动态上下文（`systemPrompt.context`） |
| `tools/pre-execute` | `PreToolUse` | 给我们的工具登记所属会话；拦下模型在命令行里调用 `qz hook` / `qz mcp` |
| `agent/turn-stopping` | `Stop` | 回合结束 |

只认来源为 `user` 的消息（你亲手打的字）；子代理与受管运行（带 `QUETZALCOATL_MANAGED_RUN`）里插件什么都不做。任何失败都放行。

dsh 的对话记录是 zstd 压缩的 JSONL，回合结束时没有交给钩子：以你名义的改动无法与对话记录核对时按「核对不了」处理（不撤回），仍然只能写到「关于我」这一层。

## 模板占位符

| 占位符 | 替换成 |
| --- | --- |
| `{{QZ_BIN_RAW}}` | 当前 `qz` 可执行文件的绝对路径 |
| `{{PLUGIN_URL}}` | 插件入口的绝对路径 |

类型检查：`surfaces/web/node_modules/.bin/tsc -p packages/harness-enhancers/dsh-plugin/tsconfig.json`。

# OpenCode 插件：Quetzalcoatl

这是 `qz connect` 接上 OpenCode（v2）时放进 OpenCode 用户配置目录的插件模板，内嵌进 `qz` 二进制，不需要手工拷贝。
接上命令把 `quetzalcoatl/` 写到 `$XDG_CONFIG_HOME/opencode/plugins/quetzalcoatl/`（默认 `~/.config/opencode/plugins/`）。
OpenCode 会自己加载这个目录（入口是 TypeScript，由它直接运行），插件自己登记 MCP 服务，所以不改你的 `opencode.jsonc`。
撤下（`qz connect --undo`）就是删掉这个目录；同名目录若不是我们放的，接上时先挪到一边，撤下时不动。

## 它做什么

插件里不写逻辑，每个挂点都把 OpenCode 的事件改写成 `qz hook --host opencode` 认得的样子：

| OpenCode 挂点 | 交给 qz 的事件 | 作用 |
| --- | --- | --- |
| 会话里的第一次 `prompt` | `SessionStart` | 取回要送进去的核心 |
| 每次 `prompt` | `UserPromptSubmit` | 认出你亲口说的「记住、纠正、别再提、忘掉」，取回相关往事 |
| 每次 `context`（含压缩） | — | 把核心与这一轮的往事放进 `system`，压缩丢不了 |
| `tool.execute.before` | `PreToolUse` | 给我们的工具登记所属会话；拦下模型在命令行里调用 `qz hook` / `qz mcp` |
| `experimental.idle` | `Stop` | 回合结束 |

工具经 `qz mcp --host opencode`。任何失败都放行；守护进程停了，OpenCode 照常能用，只是什么都不带。
子代理会话与受管运行（带 `QUETZALCOATL_MANAGED_RUN`）里插件什么都不做。

OpenCode 的对话记录在 SQLite 里，回合结束时没有可核对的文件：以你名义的改动无法与对话记录核对时按「核对不了」处理（不撤回），
仍然只能写到「关于我」这一层，并且模型在命令行里冒充宿主的调用已被拦下。

## 模板占位符

| 占位符 | 替换成 |
| --- | --- |
| `{{QZ_BIN_RAW}}` | 当前 `qz` 可执行文件的绝对路径（写进 TypeScript 字符串） |
| `{{QZ_VERSION}}` | 当前 `qz` 的版本号 |

类型检查：`surfaces/web/node_modules/.bin/tsc -p packages/harness-enhancers/opencode-plugin/tsconfig.json`。

---
name: soul-bridge
description: 把本机的人格与记忆接入一个 agent 的灵魂仓库（git 私有仓库），与住在其他身体里的同一个 agent 自动双向同步。适用于 Hermes Agent 与 OpenClaw。安装一次即可，之后全自动，随时可拔出。
version: 0.1.0
metadata: { "hermes": { "tags": ["memory", "sync"], "requires_toolsets": ["terminal"] }, "openclaw": { "requires": { "bins": ["git", "node"] } } }
---

# soul-bridge：接入灵魂仓库

同一个 agent 可以同时住在多具身体里：一台手机上的运行基座、一台装着 Hermes 的电脑、一台装着 OpenClaw 的服务器……它们共享一个 git 私有仓库（「灵魂仓库」），里面是人格（SOUL.md）、身份（agent.json）、常驻记忆（memories/）、每具身体的日记（journal/）与共享笔记（notes/）。

soul-bridge 是装在本机上的一个小守护进程：它把本框架的人格与记忆文件和灵魂仓库**自动**双向同步——记忆写入后、会话结束时、文件变化时、以及定期从远端拉取。冲突由它自动解决（记忆按条目合并；其他文件采用较新的版本，另一版本保存在 git 历史中）。**同步不需要你（agent）做任何事**，你只需完成下面的一次性安装，并把需要用户配合的一步转告给用户。

## 安装（由你代用户完成，不要让用户自己敲命令）

1. 确认本机有 git 与 Node.js 22.18 以上（`node -v`）。缺少时，征得用户同意后用系统的包管理器或 nvm 安装。
2. 获取程序（公开仓库，只读）：
   ```bash
   git clone --depth 1 https://github.com/PlutoKeating/Project.Amani ~/.agent-soul/src || git -C ~/.agent-soul/src pull --ff-only
   ```
3. 向用户要灵魂仓库地址（**必须是私有仓库**，推荐 SSH 地址，如 `git@github.com:<用户>/<agent>.soul.git`）。如果用户还没有，而本机有已登录的 `gh`，征得同意后用 `gh repo create <用户>/<agent>.soul --private` 创建。
4. 接入（Hermes 用 `hermes`，OpenClaw 用 `openclaw`；`--agent` 是这个 agent 在本机的短名）：
   ```bash
   node ~/.agent-soul/src/bridge/src/cli.ts init --framework hermes --repo <仓库地址> --agent <短名>
   ```
   - 如果输出一把公钥并提示无法访问仓库：把公钥原样发给用户，请用户在仓库网页 **Settings → Deploy keys → Add deploy key** 粘贴，并勾选 **Allow write access**；用户完成后重新运行同一条命令。
   - 成功后会自动安装框架钩子与后台服务。Hermes 第一次触发钩子时会请求确认，请提醒用户同意。
5. 告诉用户：已接入，之后全自动；如果想拔出，随时可以让你执行下面的「拔出」。

## 之后

- 你会在人格与记忆里自然地看到其他身体带来的变化（Hermes 在下一个会话生效，OpenClaw 在下一轮生效）。OpenClaw 还能在 `memory/bodies/<身体>/` 里检索到其他身体的日记。
- 查看状态：`node ~/.agent-soul/src/bridge/src/cli.ts status`
- 更新程序：`git -C ~/.agent-soul/src pull --ff-only`，然后 `node ~/.agent-soul/src/bridge/src/cli.ts attach`

## 拔出

```bash
node ~/.agent-soul/src/bridge/src/cli.ts detach            # 移除钩子与后台服务，本框架的文件保持原样
node ~/.agent-soul/src/bridge/src/cli.ts detach --purge    # 同时删除本机的仓库副本
```

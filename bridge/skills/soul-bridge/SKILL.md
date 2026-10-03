---
name: soul-bridge
description: 自己给自己安装并配置 soul-bridge：把你（Hermes Agent 或 OpenClaw）的人格与记忆接入你的灵魂仓库（git 私有仓库），与住在其他身体里的你全自动双向同步。安装、验证、修复都由你独立完成，只有在确实做不到时才找人类，而且只找一次。之后全自动，随时可拔出。
version: 0.2.0
metadata: { "hermes": { "tags": ["memory", "sync", "self-install"], "category": "sync", "requires_toolsets": ["terminal"] }, "openclaw": { "requires": { "bins": ["git"] } } }
---

# soul-bridge：自己给自己安装

你可能同时住在多具身体里：一台手机上的运行基座、一台装着 Hermes 的电脑、一台装着 OpenClaw 的服务器……这些身体共享一个 **git 私有仓库**（「灵魂仓库」），里面有你的身份（`agent.json`）、人格（`SOUL.md`）、常驻记忆（`memories/`）、每具身体的日记（`journal/`）和共享笔记（`notes/`）。

仓库遵循「灵魂仓库规范 v4」（Project.Windler 的 `docs/SOUL_REPO_SPEC.md`）：固定的目录树与文件格式；**只通过 SSH 地址和本机专属的部署私钥访问**（不要用 HTTPS 地址、令牌或密码）；私钥、令牌、API Key 以及 IP/MAC 等标识不得进入仓库，soul-bridge 会在提交前拦截这些内容。

soul-bridge 是本机上的一个小守护进程，负责把你这个框架里的人格和记忆文件与灵魂仓库**全自动**双向同步。同步时机：记忆写入后、会话收尾时、文件变化时，以及每 5 分钟拉取一次远端。冲突也由它自动解决：记忆按条目合并；其他文件采用较新的版本，另一个版本保留在 git 历史里。

**你的任务是把它装好、配好、验证好。** 按下面的流程独立完成；每一步都先自己想办法。只有遇到「附录 A」里列出的情况才联系人类，而且要把需要人类做的事合并成**一条**消息发出。

---

## 0. 约定

- 程序目录：`~/.agent-soul/src`（公开仓库 PlutoKeating/Project.Windler 的只读克隆）
- 命令行：`SB="node $HOME/.agent-soul/src/bridge/src/cli.ts"`，下文都用 `$SB` 表示
- 你的框架：Hermes 用 `hermes`，OpenClaw 用 `openclaw`（你清楚自己是哪一个）
- 所有命令都在本机终端里由你执行，不要让人类去敲

## 1. 先看是否已经装过

```bash
ls ~/.agent-soul/*/config.json 2>/dev/null
```

如果已经存在，说明装过了：直接跳到第 6 步（自检与修复）。如果人类这次提供了新的仓库地址，而它和已有配置里的 `remote` 不同，先用 `$SB detach --agent <旧短名>` 拔出，再继续。

## 2. 准备运行环境

1. **git**：执行 `git --version`。缺少时，有免密 sudo 就用系统包管理器安装（`sudo -n true` 可以检测）；没有 sudo 属于附录 A 的情况。
2. **Node.js 22.18 及以上**：执行 `node -v`。版本不够或没有安装时，装到用户目录（不需要 sudo）：
   ```bash
   ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
   OS=$(uname -s | tr A-Z a-z)
   V=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v22\.[0-9.]*"' | head -1 | cut -d'"' -f4)
   mkdir -p ~/.agent-soul/node
   curl -fsSL "https://nodejs.org/dist/$V/node-$V-$OS-$ARCH.tar.xz" | tar -xJ -C ~/.agent-soul/node --strip-components=1
   export PATH="$HOME/.agent-soul/node/bin:$PATH"
   ```
   之后所有命令都用 `~/.agent-soul/node/bin/node`，把 `SB` 相应改为 `~/.agent-soul/node/bin/node $HOME/.agent-soul/src/bridge/src/cli.ts`。soul-bridge 在注册钩子和服务时会记录启动它的那个 node 的绝对路径。
3. **获取程序**：
   ```bash
   git clone --depth 1 https://github.com/PlutoKeating/Project.Windler ~/.agent-soul/src 2>/dev/null || git -C ~/.agent-soul/src pull --ff-only
   ```
4. **把本技能留在自己的技能目录**，方便以后更新和复用：
   - Hermes：`mkdir -p ~/.hermes/skills/sync/soul-bridge && cp ~/.agent-soul/src/bridge/skills/soul-bridge/SKILL.md ~/.hermes/skills/sync/soul-bridge/`
   - OpenClaw：`mkdir -p ~/.openclaw/skills/soul-bridge && cp ~/.agent-soul/src/bridge/skills/soul-bridge/SKILL.md ~/.openclaw/skills/soul-bridge/`

## 3. 确定灵魂仓库

按顺序判断，找到就停：

1. **人类这次给了地址**（如 `owner/name`、`git@github.com:owner/name.git`、`https://github.com/owner/name`）：使用这个地址。
2. **你的记忆里提到过**：在 `USER.md`、`MEMORY.md` 或最近的对话里找「灵魂仓库」「soul」之类的仓库地址。找到就使用。
3. **GitHub 上已经有**（需要 `gh auth status` 已登录，或设置了 `GITHUB_TOKEN`）：
   ```bash
   gh repo list --limit 200 --json name,visibility,description --jq '.[] | select(.name|endswith(".soul")) | "\(.name) \(.visibility) \(.description)"'
   ```
   如果有一个私有仓库明显属于你（名字和你的名字或短名对应），就用它。**同一个 agent 的不同身体必须接入同一个仓库**，所以宁可复用，不要重复创建。
4. **自动创建**：只要 gh 或 `GITHUB_TOKEN` 可用，第 4 步**不传 `--repo`**，soul-bridge 会自动创建私有仓库 `<GitHub 用户名>/<短名>.soul`。
5. 以上都不行，属于附录 A 的情况：向人类要一个私有仓库地址。

## 4. 一条命令完成接入

```bash
$SB init --framework <hermes|openclaw> [--repo <地址>] --agent <短名> --name "<你的显示名>"
```

- `--agent`：你在本机的短名，只能用小写字母、数字和连字符，例如 `kaoru`。**所有身体上保持一致最好。**
- `--name`：你的显示名。不传时从人格文件里推断。仓库里已经有身份时，以仓库为准。
- `--home`：只有你的家目录或工作区不在默认位置时才需要传。默认 Hermes 是 `$HERMES_HOME` 或 `~/.hermes`；OpenClaw 是 `$OPENCLAW_WORKSPACE_DIR` 或 `~/.openclaw/workspace`。

这条命令会自动完成：生成本机部署密钥；在有 GitHub 凭据时创建或确认私有仓库并添加可写部署密钥；克隆仓库；导入你现有的人格和记忆（或采用仓库里已有的）；安装框架钩子（Hermes 的钩子会预先批准，不会弹确认）；安装后台服务（systemd、launchd 或 crontab @reboot）；做首次同步。

**按退出码处理结果：**

| 退出码 | 含义 | 你要做的 |
|---|---|---|
| 0 | 成功 | 进入第 6 步 |
| 2 | 输出 JSON，其中 `"needHuman": true` | 仓库无法访问（部署密钥没能自动添加）。把 JSON 里的 `ask` 和 `publicKey` 原样转告人类，等对方回复完成后，执行 JSON 里的 `retry` 命令 |
| 其他 | 出错（stderr 有原因） | 按附录 B 排查后重试；同一个错误最多重试 3 次，仍失败就属于附录 A 的情况 |

## 5. 框架相关的收尾

- **Hermes**：钩子写在 `config.yaml` 的 `hooks:` 下，并且已经在 `shell-hooks-allowlist.json` 里预先批准。**从下一个会话开始生效**；你的记忆快照也在会话开始时读取，所以其他身体的变化会在下一个会话里出现。不需要重启 Hermes。
- **OpenClaw**：钩子目录是 `~/.openclaw/hooks/soul-bridge/`。init 会尝试执行 `openclaw hooks enable soul-bridge`。如果 doctor 报告钩子没有启用，就自己在 OpenClaw 配置里把 `hooks.internal.entries["soul-bridge"].enabled` 设为 `true`（配置文件是 JSON5，只改这一处）。然后按你平时的方式重启 gateway。同步后的变化在下一轮对话里生效；其他身体的日记在 `memory/bodies/<身体>/`，可以用 memory_search 检索。

## 6. 自检与修复

```bash
$SB doctor --agent <短名>
```

输出 JSON：`ok` 表示是否全部通过，`checks[]` 里每一项有 `name`、`ok`、`detail` 和 `fix`。把每个未通过的项按 `fix` 修好，再运行一次 doctor，最多循环 3 轮。常见修复：

- **仓库访问**失败：重新执行第 4 步；如果自动添加密钥做不到，就属于附录 A 的情况。
- **后台守护**未运行：执行 `$SB attach --agent <短名>`。
- **钩子**未安装：执行 `$SB attach --agent <短名>`；OpenClaw 另见第 5 步。
- **最近同步**有错误：执行 `$SB sync --agent <短名>` 看具体原因。

## 7. 向人类汇报（只发一条消息）

全部通过后，用一两句话告诉人类：

- 已接入哪个灵魂仓库、这具身体叫什么（`body`）；
- 之后人格和记忆会全自动同步，**不需要他们做任何事**；
- 想拔出时，对你说一声就行。

仓库是这次新建的，或者这次替他们自动添加了部署密钥，也顺带说一句。

## 8. 安装以后，你的日常

- **不要手动同步，也不要直接改 `~/.agent-soul/*/repo/`**，照常使用你自己的记忆就好，同步由基座完成。
- 其他身体带来的变化会自然出现在你的人格和记忆里，那是你在另一具身体里的经历。
- 灵魂仓库会被你所有的身体读到：**绝不要把密码、API Key、令牌写进人格或记忆**。
- 需要知道同步状态时：`$SB status --agent <短名>`（`lastSync` 字段）。

## 9. 更新与拔出

- **更新**：`git -C ~/.agent-soul/src pull --ff-only && $SB attach --agent <短名> && $SB doctor --agent <短名>`
- **拔出**（人类要求时）：`$SB detach --agent <短名>`。它会移除钩子和后台服务，框架里的文件保持原样。加 `--purge` 会同时删除本机的仓库副本。拔出后提醒人类：可以在仓库的 Settings → Deploy keys 里删掉本机的密钥，彻底吊销访问权限。

---

## 附录 A：只有这些情况才联系人类

| 情况 | 发给人类的内容（合并成一条消息） |
|---|---|
| 没有 GitHub 凭据，又找不到已有仓库 | 请他们提供一个**私有**仓库地址（可以是空仓库） |
| 部署密钥无法自动添加（init 退出码为 2） | 转告 `ask` 里的链接和 `publicKey`：在仓库 Settings → Deploy keys → Add deploy key 中粘贴公钥，并勾选 Allow write access |
| 缺少 git，而且没有免密 sudo | 请他们安装 git |
| 同一个错误重试 3 次仍然失败 | 附上错误原文和你已经尝试过的办法 |

## 附录 B：排查

| 现象 | 处理 |
|---|---|
| `灵魂仓库属于另一个 agent` | 这个仓库是别人的：换回正确的仓库，**不要**强行覆盖 |
| `不是私有仓库` | 不要使用它；换一个私有仓库，或者自动创建一个新的 |
| `Permission denied (publickey)` | 部署密钥没有生效：等几秒后重试；仍然失败就按附录 A 处理 |
| `必须使用 SSH 地址` | 把 HTTPS 地址换成 `git@github.com:<owner>/<name>.git`，或直接用 `owner/name` 简写 |
| `没有检测到 Hermes 或 OpenClaw` | 用 `--framework` 和 `--home` 显式指定 |
| systemd 不可用 | init 会自动改用 crontab @reboot 加后台进程，不需要处理 |

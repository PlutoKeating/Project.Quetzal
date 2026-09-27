---
name: amani-soul
description: 把本机 Hermes 的人格（SOUL.md）与常驻记忆（MEMORY.md / USER.md）接入 Amani 的共享灵魂仓库，让住在其他身体里的 Amani 与你共享同一份人格、记忆、笔记与日记。在会话开始前与结束后同步。
---

# amani-soul：与其他身体共享灵魂

Amani（神谷薰）可以同时住在多具身体里。所有身体共享一个 git 仓库（「灵魂仓库」，必须是**私有**仓库），布局与 Hermes 一致：

```
SOUL.md                    人格
memories/MEMORY.md         你自己的笔记（§ 分隔）
memories/USER.md           关于用户的认识（§ 分隔）
journal/<身体>/<日期>.md   每具身体各自的日记
notes/<主题>.md            共享的长期笔记
```

## 首次安装（由你——Hermes——替用户完成，不要让用户自己敲命令）

1. 向用户要灵魂仓库的地址（例如 `git@github.com:<用户>/Amani.Soul.git`）。如果用户还没有，而本机有已登录的 `gh`，征得同意后用 `gh repo create <用户>/Amani.Soul --private` 创建。
2. 运行：`python3 ~/.hermes/skills/amani-soul/soul_sync.py init <仓库地址>`
   - 仓库为空时，会把本机现有的 `SOUL.md`、`memories/MEMORY.md`、`memories/USER.md` 作为初始内容推上去；
   - 仓库已有内容时，会先按条目合并本机记忆，再接入；
   - 原文件备份到 `~/.hermes/backup-amani-soul-<时间>/`，然后把 `~/.hermes/SOUL.md` 与 `~/.hermes/memories/*.md` 换成指向 `~/amani-soul/` 的软链接。
3. 如果推送因权限失败，把 `~/.ssh` 里的公钥（或新生成一把：`ssh-keygen -t ed25519 -f ~/.ssh/amani_soul -N ''`）告诉用户，请用户在仓库网页的 Deploy keys 里添加并勾选写权限，然后重试第 2 步。

## 每次会话

- **开始前**运行 `python3 ~/.hermes/skills/amani-soul/soul_sync.py sync`，拿到其他身体的新记忆（记忆在会话开始时注入，所以要先同步）。
- **结束后**把这次会话里值得记住的经历，用一两段话追加到今天的日记：
  `python3 ~/.hermes/skills/amani-soul/soul_sync.py journal "<标题>" "<正文>"`
  然后再运行一次 `sync`。
- 读到 `journal/` 下其他身体的日记时，那是「你」在另一具身体里的经历，可以自然地提起。

## 冲突规则（脚本自动处理）

- `memories/*.md`：条目级三方合并——双方新增都保留，任一方删除即删除。超出字符上限时，下次整理记忆时合并精简。
- `SOUL.md`：保留本机版本，对方版本另存为 `SOUL.incoming.md`；请在方便时读一读，调和成一个版本写回 `SOUL.md`，并删除 `SOUL.incoming.md`。

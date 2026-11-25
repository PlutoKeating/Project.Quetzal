import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "脊柱、导出与备份",
    doc: {
      title: "脊柱、导出与备份",
      description: "V2 的事件脊柱、qz export 的可读 ZIP、跨设备同步与冷备份边界；没有 Git 灵魂仓库。",
      lead:
        "V2 没有 Git 灵魂仓库。记忆与状态放在一条单写者签名的 HLC 事件脊柱上；备份是一条命令、一个你可以自己读的 ZIP。",
      blocks: [
        { kind: "h2", id: "inside", text: "脊柱里有什么" },
        {
          kind: "ul",
          items: [
            "**签名 HLC 事件日志**：只追加，每条事件带混合逻辑时钟与设备签名；未来时钟偏置超过 5 分钟的事件会被隔离拒收。",
            "**SQLite WAL 物化视图**：事件、快照、记忆索引、会话与运行记录，供查询与界面使用。",
            "**zstd E2EE Packfile**：设备之间同步的单位，压缩后在 AEAD 加密前按 2 的幂次分桶填充长度，避免 CRIME 侧信道。",
            "**工作区与技能**：可读的 Markdown / 脚本，落在家目录下，随导出一起打包。",
          ],
        },
        { kind: "h2", id: "no-git", text: "为什么废除 Git 灵魂仓库" },
        {
          kind: "p",
          text:
            "V1 用 SSH + Git 同步 SOUL 仓库，结果是「记忆可以被 force-push 覆盖」。V2 把写路径收敛为单写者签名事件脊柱 + 加密 Packfile：没有第二条可写路径，也没有 `git push --force` 能改写的记忆。V1 的历史只通过单向幂等的 `qz import-v1` 迁移进来。",
        },
        { kind: "h2", id: "export", text: "导出一份可读的备份" },
        {
          kind: "code",
          title: "shell",
          text: `qz export ~/backups/quetzalcoatl-$(date +%F).zip
# 只导出人类可读部分，不含密封脊柱
qz export ~/backups/readable-$(date +%F).zip --no-sealed-spine
# 指定另一个家目录（例如离线检查一份旧备份）
qz export /tmp/check.zip --home /media/old-disk/.quetzalcoatl`,
        },
        {
          kind: "ul",
          items: [
            "`SOUL.md`：身份、价值观与长期偏好的人类可读快照。",
            "`conscience/`：五档良知当前内容与最近的升格 / 回滚事件。",
            "`memories/`：按项目 / 记录 / 章节组织的 Markdown 树。",
            "`skills/`：技能脚本与它们的来源运行记录。",
            "`.quetzalcoatl-spine/`：签名的密封离线包，恢复与校验的依据。",
          ],
        },
        {
          kind: "note",
          text:
            "可读部分是为了让你能看、能改、能迁移；`.quetzalcoatl-spine/` 才是恢复时被校验的那份。两者在同一个 ZIP 里，不会各说各话。",
        },
        { kind: "h2", id: "sync", text: "跨设备：同步不是备份" },
        {
          kind: "p",
          text:
            "配对后的设备经 `quetzalcoatl-hub` 秒级交换加密 Packfile，错峰开关机也能拉齐。hub 只中转密文，读不到内容。但同步会忠实传播删除与失效事件——误删也会同步过去，所以它不能替代冷备份。",
        },
        { kind: "h2", id: "restore", text: "恢复与迁移" },
        {
          kind: "steps",
          items: [
            { title: "换机：先配对再同步", text: "新机器安装同版本，用同一帐号密钥与任一在线设备配对，让 Packfile 同步把状态拉齐。" },
            { title: "灾难恢复：用冷备份", text: "没有在线设备可在硬盘故障后使用导出的 ZIP。恢复前先 `qz down`，并保留原脊柱目录的副本，确保可回退。" },
            { title: "校验再导入", text: "导入端会校验事件签名与 HLC 偏置；被篡改或来自未来时钟的事件不会进入脊柱。" },
          ],
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "现状说明：导出始终可用；把 V2 导出 ZIP 导回新脊柱的底层能力已存在于 `quetzalcoatl-spine`（`SpineEngine::import_zip`），但 `qz` 目前只暴露了 `import-v1`（V1 迁移）。在 CLI 恢复入口发布前，请把 ZIP 当作可校验的冷备份，并优先用设备同步恢复。",
        },
        { kind: "h2", id: "policy", text: "备份策略" },
        {
          kind: "ul",
          items: [
            "**3-2-1**：本机一份、外置盘一份、异地一份；hub 与其它设备算同步，不算离线副本。",
            "**大版本升级前**：先 `qz export`，再升级；安装器本身只回滚二进制，不会回滚脊柱。",
            "**密钥也要备份**：`AccountRootKey` 有分片备份；没有它，加密 Packfile 无法解密，ZIP 的密封部分也打不开。",
            "**敏感文件对待**：可读 Markdown 是明文，按你对待日记的方式保管，别丢进公共网盘。",
          ],
        },
        { kind: "h2", id: "delete", text: "彻底删除" },
        {
          kind: "code",
          title: "shell",
          text: `qz down
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "p",
          text:
            "`--purge` 会删除 `QUETZALCOATL_HOME` 下的脊柱、记忆与设置。已经同步到其它设备或 hub 的密文 Packfile 需要在那一边分别删除；密钥轮换会让旧 Packfile 无法再解密。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Spine, export and backup",
    doc: {
      title: "Spine, export and backup",
      description: "The V2 event spine, qz export's readable ZIP, cross-device sync and the limits of cold backups. There is no Git soul repository.",
      lead:
        "V2 has no Git soul repository. Memory and state live on a single-writer, signed HLC event spine; a backup is one command and a ZIP you can read yourself.",
      blocks: [
        { kind: "h2", id: "inside", text: "What the spine holds" },
        {
          kind: "ul",
          items: [
            "**Signed HLC event log**: append-only; each event carries a hybrid logical clock and a device signature. Events more than five minutes ahead of trusted local time are quarantined, not accepted.",
            "**SQLite WAL materialised views**: events, snapshots, memory indexes, sessions and run records, used by queries and the UI.",
            "**zstd E2EE packfiles**: the unit of device-to-device sync. After compression, lengths are padded to power-of-two buckets before AEAD encryption, blunting CRIME-style side channels.",
            "**Workspaces and skills**: readable Markdown and scripts under the home directory, packaged with the export.",
          ],
        },
        { kind: "h2", id: "no-git", text: "Why the Git soul repository is gone" },
        {
          kind: "p",
          text:
            "V1 synced a SOUL repository over SSH and Git, which meant memory could be overwritten by a force-push. V2 collapses writes into a single-writer signed event spine plus encrypted packfiles: there is no second writable path, and no `git push --force` that can rewrite memory. V1 history enters only through the one-way, idempotent `qz import-v1`.",
        },
        { kind: "h2", id: "export", text: "Export a readable backup" },
        {
          kind: "code",
          title: "shell",
          text: `qz export ~/backups/quetzalcoatl-$(date +%F).zip
# readable part only, without the sealed spine
qz export ~/backups/readable-$(date +%F).zip --no-sealed-spine
# inspect an old backup from another home directory
qz export /tmp/check.zip --home /media/old-disk/.quetzalcoatl`,
        },
        {
          kind: "ul",
          items: [
            "`SOUL.md`: a readable snapshot of identity, values and long-lived preferences.",
            "`conscience/`: the five current tiers plus recent promotion and rollback events.",
            "`memories/`: a Markdown tree organised by project, record and section.",
            "`skills/`: skill scripts and the run records they came from.",
            "`.quetzalcoatl-spine/`: the signed sealed package used for verification and restore.",
          ],
        },
        {
          kind: "note",
          text:
            "The readable half exists so you can read, edit and migrate. `.quetzalcoatl-spine/` is what gets verified on restore. They travel in one ZIP so they cannot disagree.",
        },
        { kind: "h2", id: "sync", text: "Across devices: sync is not backup" },
        {
          kind: "p",
          text:
            "Paired devices exchange encrypted packfiles through `quetzalcoatl-hub` within seconds, even when their uptime barely overlaps. The hub only relays ciphertext and cannot read content. But sync faithfully propagates deletions and invalidations — a mistaken deletion syncs too, which is why sync cannot replace a cold backup.",
        },
        { kind: "h2", id: "restore", text: "Restore and migration" },
        {
          kind: "steps",
          items: [
            { title: "New machine: pair, then sync", text: "Install the same version, pair with any online device using the same account key, and let packfile sync bring the state over." },
            { title: "Disaster: use the cold backup", text: "With no surviving online device, use the exported ZIP. Run `qz down` first and keep a copy of the existing spine directory so the restore is reversible." },
            { title: "Verify before import", text: "The importer checks event signatures and HLC skew; tampered events or ones from the future never enter the spine." },
          ],
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "Current state: export always works. The underlying ability to import a V2 export into a new spine exists in `quetzalcoatl-spine` (`SpineEngine::import_zip`), but `qz` currently exposes only `import-v1` (V1 migration). Until the CLI restore entry ships, treat the ZIP as a verifiable cold backup and prefer device sync for recovery.",
        },
        { kind: "h2", id: "policy", text: "Backup policy" },
        {
          kind: "ul",
          items: [
            "**3-2-1**: one copy on the machine, one on an external disk, one off-site. A hub and other devices are sync, not an offline copy.",
            "**Before a major upgrade**: `qz export` first. The installer can roll back binaries; it cannot roll back your spine.",
            "**Back up the key too**: `AccountRootKey` has sharded backups. Without it, encrypted packfiles — including the sealed half of a ZIP — cannot be opened.",
            "**Treat it as sensitive**: the readable Markdown is plaintext. Store it the way you store a diary, not on a public drive.",
          ],
        },
        { kind: "h2", id: "delete", text: "Delete everything" },
        {
          kind: "code",
          title: "shell",
          text: `qz down
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "p",
          text:
            "`--purge` removes the spine, memory and settings under `QUETZALCOATL_HOME`. Ciphertext packfiles already synced to other devices or a hub must be deleted on those sides too; rotating the key makes old packfiles undecryptable.",
        },
      ],
    },
  },
};

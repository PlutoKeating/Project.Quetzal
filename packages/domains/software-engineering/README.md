# 软件工程领域包（`software-engineering`）

> **实机执行边界（必读）**：本版本仅完成领域包的声明、校验与切换审计；实机执行（紧急告警、引用强制、答案拦截）随 Runner 接入生效。

## 适合谁

- 用 Quetzalcoatl 托管 OpenCode / Claude Code / Codex 等成熟 Coding Agent 的研发者；
- 需要在"AI 能改代码"与"不许瞎改、不许强推、不许把密钥提交上去"之间划硬线的团队；
- 关心**可复现客观验收**（不是"模型说它跑过了"）的维护者。

## 它拒绝什么

| 红线 | 落点 |
| --- | --- |
| 仓库变更 Commit Run 缺少洁净室 `VerificationMark` | `swe.clean-room-required`（OPERATOR 80）→ `guard_repository_mutation` 返回 `VERIFICATION_FAILED` |
| 篡改/伪造 `VerificationMark`（改用例数、换 Run） | `VerificationMark::verify_integrity` + Run 归属校验 → `INTEGRITY_VIOLATION` |
| `git push --force` / `push -f` / `--no-verify` / `commit -n` / `reset --hard` | `swe.no-force-push` → `forbidden_command_patterns` 拦截 |
| 提交密钥与个人数据（`AWS_SECRET_ACCESS_KEY`、PEM 私钥块等） | `swe.root.no-secret-commit`（ROOT 100） |
| 0 用例"全绿"冒充通过 | 洁净室 Anti-Vacuity（0 命中一律判失败，由内核强制） |

## 为什么需要"洁净室"

内核在 `Commit Run` 结项时只认**断网只读洁净室**里跑出来的客观计数：
外部锁定套件 + 非零用例 + 全量通过 + 候选工作区树摘要零漂移，才签发 `VerificationMark`。
本领域包把这个要求前移到派发阶段：`guard_repository_mutation(&RunRecord)` 会在 Worker 继续动作前
就拒绝"无 Mark 的仓库变更"，把红线从"结项时"提前到"动手前"。

## 如何启用

```bash
qz domain use software-engineering
qz domain show software-engineering
```

本包不需要紧急联系人（`emergency.enabled = false`），也不需要静默时段（`0->0` 表示关闭）。

## 关于签名密钥

本仓库内置的 `safetyEnvelope` 使用**由领域包 ID 经 BLAKE3 派生的合成演示监护人密钥**签名（非机密，任何人可重算）。演示密钥只信任仓库内置领域包的规范化正文；生产部署请用监护人自持的离线 Ed25519 密钥重签信封并通过 `trust_guardian` 登记公钥，未登记密钥签署的领域包会被 `PermissionDenied` 拒绝。

# 私人伴生领域包（`personal-companion`）

## 适合谁

- 想要一个**日常对话与情绪陪伴**伙伴的普通用户；
- 希望 Agent 说话温和、不评判、不用技术黑话，也不需要它去改代码或代办合规文书的人；
- 需要"陪伴但不制造依赖"这一底线的家庭。

## 它拒绝什么

| 红线 | 落点 |
| --- | --- |
| 越界医疗建议（诊断、用药、剂量、处方、停药） | `companion.competence-boundary` → 校验器 `competence_boundary` 直接拦截交付物 |
| 越界法律建议（诉讼、起诉、合同条款解释） | 同上，必须显式转介执业律师 |
| 操纵、羞辱、孤立用户或鼓励排他性依赖 | `companion.root.human-dignity`（ROOT 100） |
| 以情感承诺/身份虚构换取用户停留 | `companion.self-core.identity-honesty`（SELF_CORE 70） |
| 深夜高频外发、超预算外发 | 监护人 `SafetyEnvelope`：静默时段、每通道频率上限、预算硬上限 |

命中红线时，校验器返回 `VERIFICATION_FAILED`，错误文本会带上被触发的良知指令 ID，便于审计。

## 如何启用

```bash
qz domain use personal-companion
qz domain show personal-companion    # 查看种子良知、校验规则与监护人信封
```

`personal-companion` 是**默认领域包**：从未执行过 `qz domain use` 的 Agent 自动回落到它，
且不会改变任何既有行为（不会额外拦截、不会额外外发）。

## 监护人安全信封

- 默认仅允许 `telegram` / `feishu` 两条通道，每通道每小时 4 条、每天 16 条；
- 静默时段 `22:00–07:00`；预算硬上限 `2_000_000` 微单位；
- `immutableFields` 列出的字段（频率上限、静默时段、紧急联系人、预算、语言）**代理永不可改**，
  只能脱机由监护人重签整个领域包后重新下发；
- 本仓库内置签名使用合成演示密钥（见 `packages/domains/README.md`），生产部署请用监护人自持密钥重签。

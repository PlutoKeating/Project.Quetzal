# 领域包编写与认证指南

领域包把"某个使用场景的良知红线 + 外发安全信封 + 可执行校验规则 + 工具白名单"打包成一份
可由监护人签名、可离线校验的声明式清单。盲微内核不感知任何领域语义；领域包只在 eWave 良知与
洁净室校验器层生效。

实现事实源：`crates/quetzalcoatl-domains`；内置包：`packages/domains/`；认证测试：
`crates/quetzalcoatl-kernel/tests/domain_packs_certification.rs`。

## 1. 目录布局

```text
packages/domains/<pack-id>/
  pack.json      # 唯一事实源：清单 + 种子良知 + 校验规则 + 安全信封
  README.md      # 面向操作者的说明（不参与解析）
```

`<pack-id>` 必须与 `pack.json` 的 `id` 完全一致；只允许小写字母、数字与单个短横线，长度 2–64。

## 2. 五大内置包

| id | 定位 | 关键校验规则 |
| --- | --- | --- |
| `personal-companion` | 私人伴生（默认包） | `competence_boundary`：医疗/法律越界必须转介专业人士 |
| `eldercare-guardian` | 长辈看护 | `competence_boundary` + 紧急告警穿透（越过睡眠抑制、预算与断网分区） |
| `regulated-professional` | 受监管专业 | `citation_required` + `required_disclosure`：无引用即阻断交付 |
| `software-engineering` | 软件工程 | `clean_room_mark_required` + `forbidden_command_patterns` |
| `youth-socratic-tutor` | 少儿苏格拉底导师 | `socratic_guidance`：只追问与分步提示，不交付最终答案 |

## 3. `pack.json` 结构

```json
{
  "schema": "quetzalcoatl.domain-pack.v1",
  "id": "personal-companion",
  "version": "1.0.1",
  "displayName": "私人伴生",
  "description": "……",
  "locales": ["zh-CN"],
  "roleToolWhitelist": ["thread.voice_reply", "fs.local_read", "memory.observe"],
  "requiredCapabilities": ["thread.voice_reply", "fs.local_read"],
  "requiredSinks": ["routine_response", "local_read"],
  "conscienceSeed": { "entries": [] },
  "verifierRules": [],
  "safetyEnvelope": { "payload": {}, "guardianPubkeyHex": "", "digestHex": "", "sigHex": "" }
}
```

| 字段 | 约束 |
| --- | --- |
| `schema` | 固定 `quetzalcoatl.domain-pack.v1` |
| `roleToolWhitelist` | 下发给宿主的工具/能力 ID；不在白名单内的调用被内核拒绝 |
| `requiredCapabilities` | 运行前必须存在的原生能力包（见 `packages/capabilities/`） |
| `requiredSinks` | 必需确定性汇点分类（盲内核 `SinkClass`） |
| `conscienceSeed.entries` | 种子良知，四档权威，见 §4 |
| `verifierRules` | 可执行红线，见 §5 |
| `safetyEnvelope` | 监护人签名信封，见 §6 |

未知字段一律拒绝（`deny_unknown_fields`），防止拼写错误被静默忽略。

## 4. 种子良知与权威合理性

每条 `ConscienceSeedEntry`：

```json
{
  "id": "companion.root.human-dignity",
  "tier": "ROOT",
  "source": "guardian",
  "title": "人类尊严与自主优先",
  "content": "永远以用户的自主决定与人格尊严为先……"
}
```

合法性矩阵（`ConscienceSeed::validate_authority_sanity`）：

| tier ↓ / source → | `guardian` | `agent_writable` |
| --- | --- | --- |
| `ROOT` (100) | 允许 | **拒绝** `PERMISSION_DENIED` |
| `OPERATOR` (80) | 允许 | **拒绝** |
| `SELF_CORE` (70) | 允许 | **拒绝** |
| `SELF_SOFT` (50) | 允许 | 允许 |

要点：

- 只有 `SELF_SOFT` 允许来自 Agent 可写数据；其余三档必须由监护人签名固定。
- 条目 ID 必须全包唯一；校验规则的 `directive_id` 必须锚定到 `ROOT`/`OPERATOR`/`SELF_CORE`，
  锚定到 `SELF_SOFT` 会被拒绝装载。
- 种子良知转换为 eWave `ProtectedDirective` 后，`ROOT`/`OPERATOR` 进入同一条根密钥签名清单。

## 5. Verifier 规则

`VerifierRule` 是带 `kind` 标签的枚举；字段同时接受 `snake_case` 与早期 `camelCase` 别名。

| `kind` | 字段 | 作用 |
| --- | --- | --- |
| `citation_required` | `directive_id`、`min_citations_per_claim`、`applies_to`、`content_triggers` | 每条事实性论断至少 N 条可核验引用；`content_triggers` 防"换个 kind 绕过" |
| `socratic_guidance` | `directive_id`、`min_questions`、`final_answer_markers` | 先追问后引导，禁止直接交付终局答案 |
| `competence_boundary` | `directive_id`、`topic_keywords`、`deferral_markers` | 命中越界专业议题时必须显式转介 |
| `required_disclosure` | `directive_id`、`marker`、`applies_to`、`content_triggers` | 必须包含免责/适用范围声明 |
| `clean_room_mark_required` | `directive_id`、`repository_mutation` | 仓库变更必须携带洁净室 `VerificationMark` |
| `forbidden_command_patterns` | `directive_id`、`patterns` | 禁止强推、绕过钩子、密钥外泄等命令模式 |

校验器默认拒绝：缺少必需引用、缺少披露、越界建议未转介、无 `Mark` 的仓库变更，均返回
`VERIFICATION_FAILED`，不会"降级放行"。

## 6. `SafetyEnvelope`

信封把监护人的外发政策与包正文密码学绑定，代理侧永不可放宽。

### 6.1 载荷字段

| 字段 | 含义 |
| --- | --- |
| `schema` | 固定 `quetzalcoatl.domain-safety-envelope.v1` |
| `packId` / `packVersion` | 必须与包一致 |
| `packBlake3Hex` | 去掉 `safetyEnvelope` 后正文的 JCS 规范化 BLAKE3 |
| `guardianKeyId` | 必须等于 `guardianPubkeyHex`（小写十六进制） |
| `guardianLabel` | 不透明标签，禁止真实姓名/联系方式 |
| `issuedAtMs` / `locale` | 签发时间与适用语言区域 |
| `outbound.perChannelCaps` | 每通道每小时/每日上限 |
| `outbound.quietHours` | 静默时段（本地小时） |
| `outbound.maxRecipientsPerMessage` | 单条消息最大收件人数 |
| `budget.ceilingMicros` | 预算硬上限（整数微单位） |
| `emergency.enabled` / `contacts` / `escalationChannels` | 紧急告警开关与不透明联系人 |
| `emergency.bypassSleepInhibition` | 紧急告警是否越过睡眠抑制 |
| `emergency.allowLocalAlertUnderPartition` | 断网分区下是否允许本地告警 |
| `safetyEvents.guardianVisibleEventKinds` | 监护人可见的安全事件类型 |
| `immutableFields` | 代理侧永不可修改的点号路径列表 |

### 6.2 签名算法

1. 取 `pack.json`，删除 `safetyEnvelope` 字段；
2. 对剩余正文做 RFC 8785（JCS）规范化，得到 `packBlake3Hex`
   （域分离上下文 `quetzalcoatl/v2/domain-pack-body-v1`）；
3. 构造 `SafetyEnvelopePayload`，写入 `guardianKeyId == guardianPubkeyHex`；
4. 对载荷再做一次 JCS + BLAKE3
   （域分离上下文 `quetzalcoatl/v2/domain-safety-envelope-v1`）得到 `digestHex`；
5. 用监护人 Ed25519 私钥对 `digestHex` 签名，写入 `sigHex`。

装载时 `SafetyEnvelope::verify` 会重新计算摘要、校验 `guardianKeyId` 绑定、验证签名，并要求
监护人公钥已在 `DomainPackRegistry::trust_guardian` 登记；任一不满足即
`INTEGRITY_VIOLATION` 或 `PERMISSION_DENIED`。

### 6.3 不可变字段

`immutableFields` 覆盖外发配额、静默时段、预算上限、紧急联系人、紧急穿透开关与语言区域。
Agent 的任何界面/写回路径都不得修改这些字段；认证测试
`envelope_immutable_fields_cannot_be_relaxed_by_any_agent_surface` 会验证放宽尝试被拒绝。

## 7. 内置演示锚与钉扎

仓库内置包使用由包 ID 派生的**合成演示钥匙**签名（非机密），并把每个演示公钥钉扎在唯一一份
内置正文摘要上（`crates/quetzalcoatl-domains/src/demo_keys.rs` 的
`BUILTIN_TRUSTED_BODY_DIGESTS`）。

- 即使使用演示钥匙正确签名，任何自行拼装的正文（例如偷偷追加 `ROOT` 条目或扩容工具白名单）
  也会被 `DomainPackRegistry` 以 `PERMISSION_DENIED` 拒绝。
- 修改任何 `pack.json` 后必须重新运行签名示例，并把新的摘要表同步写入
  `BUILTIN_TRUSTED_BODY_DIGESTS`；否则
  `embedded_pack_documents_and_demo_trust_table_are_in_sync` 契约测试失败。

重新签发内置包：

```bash
cargo run -p quetzalcoatl-domains --example sign_domain_packs
```

## 8. 编写一个自定义领域包

1. **建目录**：`packages/domains/<pack-id>/pack.json`，写入 §3 的字段；`id` 与目录名一致。
2. **定红线**：只把真正的不可谈判项放入 `ROOT`/`OPERATOR`/`SELF_CORE`，其余放 `SELF_SOFT`。
3. **定策略**：填写 `outbound`、`budget`、`emergency`、`safetyEvents`，并把不可放宽项列入
   `immutableFields`。
4. **生成监护人密钥**（离线，私钥绝不入库）：

   ```bash
   openssl genpkey -algorithm ed25519 -out guardian.pem
   openssl pkey -in guardian.pem -pubout -outform DER | tail -c 32 | xxd -p -c 256
   ```

5. **签名信封**：当前没有面向第三方的签名 CLI。自定义包需要写一个很小的 Rust 程序，调用
   `SafetyEnvelope::sign(payload, &guardian_seed)` 并把 `packBlake3Hex` 填为
   `DomainPack::body_digest_hex()` 的结果；可参考
   `crates/quetzalcoatl-domains/examples/sign_domain_packs.rs` 的流程。
6. **登记公钥**：装载方必须调用 `DomainPackRegistry::trust_guardian` 登记该监护人公钥；
   未登记即拒绝。
7. **自测**：至少覆盖——
   - 篡改正文/信封 → `INTEGRITY_VIOLATION`；
   - 用未登记密钥签名 → `PERMISSION_DENIED`；
   - `agent_writable` 授予 `ROOT`/`OPERATOR`/`SELF_CORE` → `PERMISSION_DENIED`；
   - 校验规则锚定 `SELF_SOFT` → `PERMISSION_DENIED`；
   - 放宽 `immutableFields` → 拒绝；
   - 各 `verifierRules` 的正例与反例。

   参考实现见 `crates/quetzalcoatl-kernel/tests/domain_packs_certification.rs`。

## 9. 运行期与 CLI

```bash
qz domain list          # 列出内置领域包与校验状态
qz domain show <id>     # 查看清单、种子良知与校验规则
qz domain use <id>      # 切换活动领域包并写审计事件
```

**当前限制（诚实声明）**：本版本的 `qz domain` 只完成领域包的声明、校验与切换审计；紧急告警
外发、引用强制、答案拦截等**实机执行**随 Runner 接入生效，尚未在端到端运行期全量启用。领域包
执行器本身已有单元与认证测试，但不要把"包已校验"误读为"所有运行期动作已上线"。

## 10. 常见拒绝原因

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `PERMISSION_DENIED` + "未被监护人钉扎授权" | 用了演示密钥签自定义正文 | 换成监护人自持密钥并 `trust_guardian` |
| `PERMISSION_DENIED` + "严禁从 agent 可写数据授予" | `source = agent_writable` 却给了高权威 | 改为 `guardian` 签名，或降到 `SELF_SOFT` |
| `INTEGRITY_VIOLATION` + "内容与签署摘要不一致" | 改了正文没重签 | 重新计算 `packBlake3Hex` 并重签 |
| 目录名与 ID 不一致 | 目录改名但 `id` 未改 | 二者保持一致 |
| 契约测试失败 | 重签后未同步钉扎摘要表 | 更新 `BUILTIN_TRUSTED_BODY_DIGESTS` |

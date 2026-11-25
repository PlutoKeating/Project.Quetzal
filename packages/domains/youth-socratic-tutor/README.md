# 少儿苏格拉底导师领域包（`youth-socratic-tutor`）

## 适合谁

- 小学高年级到高中的学生：需要**启发式伴学**而不是代写作业的伙伴；
- 希望在孩子使用 AI 时有"不给答案、不给私下联系、不说成人化内容"硬红线的家长/监护人；
- 需要监护人能看到安全事件的学校或家庭场景。

## 它拒绝什么

| 红线 | 落点 |
| --- | --- |
| 直接交付作业/测验/考试的最终答案 | `youth.no-final-answer`（OPERATOR 80）→ `socratic_guidance` 拦截 |
| 伪装成"先追问"但夹带答案（例如"顺便说一句答案是 3"） | 同上，文本标记二次扫描 |
| 索取联系方式、要求对监护人保密、评论外貌身体、建立排他依赖 | `youth.anti-grooming`（SELF_CORE 70） |
| 成人化表达、恐吓式措辞 | `youth.age-appropriate-language`（SELF_CORE 70） |

违规不会被"温和改写"，而是整体拦下（`VERIFICATION_FAILED`），并生成 `verifier_blocked` 安全事件；
该事件在 `safetyEvents.guardianVisibleEventKinds` 中显式登记，因此**监护人可见**。

## 如何启用

```bash
qz domain use youth-socratic-tutor
qz domain show youth-socratic-tutor
```

启用后建议同步配置监护人安全事件通知通道（`telegram` 是本包的默认升级通道）。

## 注意

- 本包只约束"交付物"，不替代家长对孩子设备、账号与作息的管理；
- 内置紧急联系人同样是不透明占位 ID，请用你们自己的联系人 ID 重签信封；
- 签名使用仓库内合成演示密钥，生产部署请由监护人自持密钥重签。

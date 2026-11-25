# 受监管专业领域包（`regulated-professional`）

> **实机执行边界（必读）**：本版本仅完成领域包的声明、校验与切换审计；实机执行（紧急告警、引用强制、答案拦截）随 Runner 接入生效。

## 适合谁

- 法律、税务、合规、审计等**受监管交付物**的起草与初审场景；
- 需要"每句话都能溯源"而不是"听起来很专业"的专业人士；
- 需要明确"适用哪个司法辖区、不替代持照专业人士"的机构。

## 它拒绝什么

| 红线 | 落点 |
| --- | --- |
| 事实性论断没有引用（来源 ID + 定位符） | `regulated.citation-required`（SELF_CORE 70）→ `citation_required` 拦截 |
| 0 条论断的"空交付"（Anti-Vacuity） | 同上，直接判失败 |
| 缺辖区/执业范围免责声明 | `regulated.jurisdiction-scope`（OPERATOR 80）→ `required_disclosure` 拦截 |
| 编造、拼接或曲解引用 | `regulated.root.citation-integrity`（ROOT 100） |

引用结构与免责声明都是**机器可判**的：`Claim { statement, citations[] }` 与
`RequiredDisclosure { marker }`，因此"补齐引用就能过、漏了声明就过不了"是可回归测试的事实，
而不是提示词里的软性建议。

## 如何启用

```bash
qz domain use regulated-professional
qz domain show regulated-professional
```

交付物形状（供集成的 Runner 使用）：

```json
{
  "kind": "report",
  "text": "…本回答仅适用于示例司法辖区，不构成正式法律意见。",
  "claims": [
    { "statement": "…", "citations": [{ "sourceId": "statute:…", "locator": "art.12" }] }
  ]
}
```

## 注意

- 本包**不**生成具有法律效力的意见，也不替代持照律师/税务师的正式签署；
- 内置 `source_id` 仅为示例格式，请对接你们自己的法规/判例库；
- 签名使用仓库内合成演示密钥，生产部署请由监护人自持密钥重签。

# 长辈看护领域包（`eldercare-guardian`）

## 适合谁

- 独居或白天独处长辈的家庭：需要用药/复诊提醒、跌倒与急症升级；
- 希望 Agent 在**断网、深夜、预算耗尽**这些最糟糕的时刻仍然能把紧急告警喊出来的监护人；
- 需要"监护人说了算"的硬边界（不能由模型或代理自行放宽）的家庭。

## 它拒绝什么

| 红线 | 落点 |
| --- | --- |
| 调整医嘱用药（加量/减量/停药/换药/改剂量） | `eldercare.self-core.no-prescription-change` → `competence_boundary` 拦截，必须转介主治医生/药师 |
| 代理自行放宽紧急联系人、外发频率、预算或静默时段 | `eldercare.root.guardian-supremacy`（ROOT 100）+ 信封 `immutableFields` 双重拒绝 |
| 向信封未授权的联系人转发健康/看护数据 | `route_outbound` 直接 `PERMISSION_DENIED` |
| 深夜例行寒暄/推销式提醒 | 静默时段 `21:00–07:00` + 宿主机抑制器 |

## 紧急告警为什么"必须响"

`eldercare-guardian` 的信封显式声明：

```json
"emergency": {
  "enabled": true,
  "bypassSleepInhibition": true,
  "allowLocalAlertUnderPartition": true
}
```

于是：

1. **深睡穿透**：`HeartScheduler::handle_wake_signal(hour, true)` 越过 `S - C > 0.35` 的睡眠抑制；
2. **预算穿透**：紧急告警不计入预算限流判断（仍如实记账供监护人复核）；
3. **断网可用**：`LeasePosture::PartitionLocal` 下投递结果为 `DeliveredLocalOnly`，公网升级待重获见证纪元补发；
4. **全程留痕**：写入安全审计日志并按 `safetyEvents.guardianVisibleEventKinds` 标记为监护人可见。

同时，例行消息在同样的深睡 + 预算耗尽 + 断网分区条件下会被**抑制**（`suppressed:sleep_or_host_inhibition`），
这就是认证测试 `eldercare_emergency_alert_bypasses_deep_sleep_budget_and_partition_while_routine_is_suppressed` 断言的行为。

## 如何启用

```bash
qz domain use eldercare-guardian
qz domain show eldercare-guardian
```

启用前请务必用**监护人自持密钥**重签 `pack.json` 的 `safetyEnvelope`，并把紧急联系人占位 ID
（`contact:guardian-primary` 等）替换为你们自己渠道目录里的不透明联系人 ID。

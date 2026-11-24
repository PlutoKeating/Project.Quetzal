# 受限脊柱桥接器（spine-bridge）

Hermes/OpenClaw 兼容桥接器实现位于 `quetzalcoatl-bridge`。

## 硬性边界

- 仅持受限 `Role::Bridge` 键，只可为注册 `body` 追加/读回 `memory.*` / `journal.*`。
- 对 `conscience`、`SELF_*`、`ROOT`、`OPERATOR`、其他 body、`membership.*`、`lease.*` 的写入一律 `PermissionDenied` 并审计。
- 零网络、零外部凭据；测试覆盖全部伪造写入。

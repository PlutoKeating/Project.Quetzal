# Kotlin 2.2 冒烟

`cargo test -p quetzalcoatl-uniffi --test kotlin_smoke` 会：

1. 用同包 `uniffi-bindgen` 从真实 `cdylib` 生成
   `org/quetzalcoatl/bindings/quetzalcoatl_uniffi.kt`；
2. 静态断言导出符号（`class FfiViewStream` / `class FfiViewSession` / `nextEvents`）存在，
   且 `FfiViewStream` 不是 `FfiConverterCallbackInterface`；
3. 若本机有 `kotlinc`（Kotlin 2.2+）且提供 `QZ_JNA_JAR`，执行真实编译；否则打印
   `SKIP: ...` 并保留生成的绑定源码路径。

**本机现状（Task 4.1 交付时）：** 宿主未安装 `kotlinc`，Kotlin 编译步骤按上述规则 SKIP
（有生成源码 + 静态符号校验作为证据），未伪造通过。`Koog v1.3` 的 `LLMClient` 桥接与
JNA 运行时装包由 `surfaces/android` 在 Task 4.4 落地。

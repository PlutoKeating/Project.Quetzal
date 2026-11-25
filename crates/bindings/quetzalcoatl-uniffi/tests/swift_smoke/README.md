# Swift 6 冒烟

`cargo test -p quetzalcoatl-uniffi --test swift_smoke` 会：

1. 用同包 `uniffi-bindgen` 从真实 `cdylib` 生成 `QuetzalcoatlBindings.swift`；
2. 静态断言导出符号（`FfiViewStream` / `FfiViewSession` / `FfiCognitionDensity` / `nextEvents`）
   存在，且不含任何 `CallbackInterface`（拉模式唯一）；
3. 若本机有 `swiftc`（Swift 6.2+），执行 `swiftc -typecheck`；否则打印
   `SKIP: 本机未安装 swiftc ...` 并保留生成的绑定源码路径。

**本机现状（Task 4.1 交付时）：** 宿主未安装 Swift 工具链，因此 Swift 编译步骤按上述规则
SKIP（有生成源码 + 静态符号校验作为证据），未伪造通过。Swift 消费方工程与
`AsyncThrowingStream` 拉模式封装由 `surfaces/macos` 在 Task 4.3 落地。

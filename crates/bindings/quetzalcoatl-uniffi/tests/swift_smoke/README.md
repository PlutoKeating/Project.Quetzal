# Swift 6 冒烟

`cargo test -p quetzalcoatl-uniffi --test swift_smoke` 会：

1. 用同包 `uniffi-bindgen` 从真实 `cdylib` 生成 `QuetzalcoatlBindings.swift`；
2. 静态断言导出符号（`FfiViewSession` / `FfiCognitionDensity` / `densityPatch`）
   存在，不再导出已撤销的 `FfiViewStream`，且不含任何 `CallbackInterface`；
3. 若本机有 `swiftc`（Swift 6.2+），执行 `swiftc -typecheck`；否则打印
   `SKIP: 本机未安装 swiftc ...` 并保留生成的绑定源码路径。

**本机现状（Task 4.1 交付时）：** 宿主未安装 Swift 工具链，因此 Swift 编译步骤按上述规则
SKIP（有生成源码 + 静态符号校验作为证据），未伪造通过。

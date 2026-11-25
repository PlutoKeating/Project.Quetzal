# `quetzalcoatl-uniffi`

Swift 6 / Kotlin 2.2 / .NET 9+ 的 **拉模式** UniFFI 绑定层（防坑规范 #14）。

## 版本锁定与 `uniffi-bindgen-cs` 缺口

* `uniffi = "=0.32.0"` 在根 `Cargo.toml` 精确锁定；`Cargo.lock` 中 `uniffi`、
  `uniffi_core`、`uniffi_macros`、`uniffi_meta`、`uniffi_bindgen` 全部为 `0.32.0`
  （`tests/api_surface.rs::uniffi_is_pinned_exactly_to_0_32_0` 强制）。
* `uniffi-bindgen-cs` **未发布到 crates.io**（sparse index `un/if/uniffi-bindgen-cs` → 404），
  因此无法写成 Cargo 依赖。改为按与 uniffi 0.32.0 配对的 Git 标签安装同名工具：

  ```bash
  curl -sSL -o src.tgz 'https://codeload.github.com/NordSecurity/uniffi-bindgen-cs/tar.gz/refs/tags/v0.12.0%2Bv0.32.0'
  tar xzf src.tgz
  (cd uniffi-bindgen-cs-0.12.0-v0.32.0 && cargo install --path ./bindgen --locked)
  ```

  配对关系记录在 [`bindgen-cs-pin.json`](bindgen-cs-pin.json)；
  `tests/api_surface.rs::bindgen_cs_pairing_matches_pinned_uniffi` 会读取
  `uniffi-bindgen-cs --version`（输出 `0.12.0+v0.32.0`）并断言其配对 uniffi 版本
  **等于**本工作区锁定值；工具缺失时打印 SKIP 理由（不伪装通过）。

## 零回调接口

`#[uniffi::export]` 只导出对象方法，没有任何 `callback_interface` / `with_foreign`：

* 静态门禁：`tests/api_surface.rs::exported_surface_declares_no_callback_interfaces`
  扫描手写源码禁止相关标记。
* 符号门禁：同一个测试对真实 `cdylib` 执行 `nm -D`，断言 **0 个
  `init_callback_vtable_*` 符号**（UniFFI 只为外语回调接口生成该符号）。

宿主统一使用 `FfiViewStream.next_events(maxEvents)` 主动拉取（C# `IAsyncEnumerable`
封装由 `surfaces/windows` 在 Task 4.3 落地，仍是拉模式）。

## 生成与编译冒烟脚本

```bash
scripts/uniffi-bindings.sh build-lib                 # cargo build -p quetzalcoatl-uniffi（cdylib）
scripts/uniffi-bindings.sh generate kotlin|swift|csharp [out_dir]
scripts/uniffi-bindings.sh smoke-csharp              # 生成 → dotnet 编译 → 运行极小消费方
scripts/uniffi-bindings.sh smoke-swift               # 生成 → swiftc -typecheck（缺工具链则 SKIP 77）
scripts/uniffi-bindings.sh smoke-kotlin              # 生成 → kotlinc（缺工具链则 SKIP 77）
scripts/uniffi-bindings.sh all
```

退出码：`0` 成功、`77` 工具链缺失跳过、其他为真实失败。
`cargo test -p quetzalcoatl-uniffi` 会自动驱动上述冒烟：

| 测试 | 行为 |
| --- | --- |
| `csharp_smoke` | 本机 dotnet 10.0.401 + uniffi-bindgen-cs 在位 → **真实编译并运行**，要求输出 `CSHARP_SMOKE_OK` |
| `swift_smoke` | 始终生成绑定并静态校验符号；`swiftc` 缺失 → SKIP 并打印理由 |
| `kotlin_smoke` | 始终生成绑定并静态校验符号；`kotlinc`/JNA 缺失 → SKIP 并打印理由 |
| `api_surface` | 版本锁定、配对、零回调、手写代码零 `unsafe` |

## `unsafe` 豁免精确清单

* crate 级 lint 为 `deny(unsafe_code)`（根工作区 `forbid` 的受控放宽），**手写代码零 `unsafe`**。
* 唯一的 `unsafe` 来自宏展开的 FFI 胶水：
  - `src/lib.rs:31` — `uniffi::setup_scaffolding!()` 生成的导出符号（`#[unsafe(no_mangle)]`）；
  - `src/lib.rs:244`、`src/lib.rs:346` — 两个 `#[uniffi::export] impl` 展开的 vtable/句柄胶水。
* `tests/api_surface.rs::handwritten_sources_contain_no_unsafe` 静态扫描 `src/`，禁止
  `unsafe {`、`unsafe fn`、`unsafe impl`、`unsafe extern`、`unsafe(no_mangle)` 出现在手写代码中。

## 生成配置

[`uniffi.toml`](uniffi.toml)：Kotlin 包名 `org.quetzalcoatl.bindings`、Swift 模块
`QuetzalcoatlBindings`、C# 命名空间 `Quetzalcoatl.Bindings` 且 `access_modifier = "public"`
（`uniffi-bindgen-cs` 默认生成 `internal` 类型，跨程序集无法消费）。

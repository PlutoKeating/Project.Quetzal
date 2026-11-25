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
scripts/uniffi-bindings.sh smoke-kotlin              # 生成 → kotlinc -cp $QZ_JNA_JAR（缺 kotlinc/JNA 则 SKIP 77）
scripts/uniffi-bindings.sh all
```

退出码：`0` 成功、`77` 工具链缺失跳过、其他为真实失败。
`cargo test -p quetzalcoatl-uniffi` 会自动驱动上述冒烟：

| 测试 | 行为 |
| --- | --- |
| `csharp_smoke` | 本机 dotnet 10.0.401 + uniffi-bindgen-cs 在位 → **真实编译并运行**，要求输出 `CSHARP_SMOKE_OK` |
| `swift_smoke` | 始终生成绑定并静态校验符号；`swiftc` 缺失 → SKIP 并打印理由 |
| `kotlin_smoke` | 始终生成绑定并静态校验符号；`kotlinc`/JNA 缺失 → SKIP 并打印理由 |
| `api_surface` | 版本锁定、配对、零回调、手写代码零 `unsafe`、默认特性不含绑定工具链 |
| `ffi_view_session` | 行修订号保真、密度补丁纯函数语义、`rev()` 锁中毒可失败 |

## `unsafe`：`forbid`，无任何豁免

* crate 与全工作区一致启用 `#![forbid(unsafe_code)]`（`[lints] workspace = true`）。
  经实测，`uniffi::setup_scaffolding!()` 与 `#[uniffi::export]` 宏展开的
  `#[unsafe(no_mangle)]` 导出符号来自外部宏 span，不触发本 crate 的 `forbid`，
  因此**不需要任何文件/行级豁免**。
* `tests/api_surface.rs::handwritten_sources_contain_no_unsafe` 仍静态扫描 `src/`，禁止
  `unsafe {`、`unsafe fn`、`unsafe impl`、`unsafe extern`、`unsafe(no_mangle)` 出现在手写代码中。

## 交付产物不含绑定工具链

`[features] default = []`，`uniffi-bindgen` bin 标记 `required-features = ["cli"]`。
`cargo tree -p quetzalcoatl-uniffi -e normal` 的默认依赖仅含 `uniffi_core` / `uniffi_macros`
（后者作为 proc-macro 依赖 `fs-err`，只编译进宿主构建期，不进入 cdylib/staticlib）；
`clap` / `askama` / `cargo_metadata` 仅在显式 `--features cli` 出现。
`tests/api_surface.rs::default_features_never_ship_the_bindgen_toolchain` 用
`cargo metadata` 强制该约束。

## 生成配置

[`uniffi.toml`](uniffi.toml)：Kotlin 包名 `org.quetzalcoatl.bindings`、Swift 模块
`QuetzalcoatlBindings`、C# 命名空间 `Quetzalcoatl.Bindings` 且 `access_modifier = "public"`
（`uniffi-bindgen-cs` 默认生成 `internal` 类型，跨程序集无法消费）。

# C# 冒烟消费方（.NET 9+/10）

由 [`scripts/uniffi-bindings.sh smoke-csharp`](../../../../../scripts/uniffi-bindings.sh)
或 `cargo test -p quetzalcoatl-uniffi --test csharp_smoke` 驱动：

1. `uniffi-bindgen-cs` 从 `target/debug/libquetzalcoatl_uniffi.so` 生成 C# 绑定到临时目录；
2. `dotnet run` 以 `-p:QzGeneratedDir=...` 注入生成目录，以
   `-p:BaseIntermediateOutputPath/BaseOutputPath` 把 `obj/ bin/` 指向临时目录；
3. `LD_LIBRARY_PATH` 指向 cdylib，运行 `Program.cs` 并断言输出 `CSHARP_SMOKE_OK`。

`Program.cs` 覆盖：构造 `FfiViewSession`、应用补丁、幂等重放、切到 `Companion` 后确认
`detail/raw_json` 被裁剪、`FfiViewStream.NextEvents` 拉取 3 个事件、`Cancel()` 生效。

`nuget.config` 清空包源：本工程零外部 NuGet 依赖，离线可重复还原。
仓库内不会落地任何生成物（已加入根 `.gitignore` 兜底）。

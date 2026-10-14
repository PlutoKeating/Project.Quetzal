# 1.10.0 本地 CLI 包验收

日期：2026-10-14。最终运行代码基线：`1c0e895`。本记录描述本地构建与隔离安装证据，不等同于 npm / Release 发布、签名验收或跨平台实机验收。

## 环境与产物

本次平台为 Linux x64；Node.js `24.16.0`、npm `11.13.0`、Flutter `3.47.7` / Dart `3.13.5`。构建没有使用 `QUETZAL_NO_WEB=1`。

| 项目 | 本次结果 |
| --- | --- |
| npm 包 | `@plutokeating/quetzal@1.10.0`，文件名 `plutokeating-quetzal-1.10.0.tgz` |
| 包大小 | 12,407,769 字节；解包后 39,761,858 字节 |
| 内容 | 60 项，其中 52 项为 `dist/runtime/web/` 静态文件 |
| tgz SHA-256 | `684faf72d10fed845151f454b0a8dbdc628a9a2e6abda90ef2e2282d014de617` |
| 包内 `dist/runtime/main.cjs` SHA-256 | `8da002e89ea1f989b7c36b8a464a0fdfd1cc0066fd6a041aa62172b6be3e45a7` |
| 内置运行时版本 | `dist/runtime/VERSION` 为 `1.10.0` |

以上指纹仅标识本次本地构建；不同构建环境的产物不应直接假定具有相同哈希。产物和合成运行数据保留在仓库外临时目录，未纳入 Git。

## 命令与检查

执行了以下构建、打包及本地 npm 安装步骤；`acceptance_dir` 表示仓库外临时目录：

```bash
cd cli
npm test
npm run build
npm pack --json --pack-destination "$acceptance_dir"
npm install --prefix "$acceptance_dir/npm-install" --ignore-scripts --no-audit --no-fund "$acceptance_dir/plutokeating-quetzal-1.10.0.tgz"
"$acceptance_dir/npm-install/node_modules/.bin/quetzal" version
```

- CLI 测试共 47 项：45 项通过，2 项因本机没有 PowerShell 跳过。
- 完整构建包含 Flutter Web；构建期间移动的 Android 运行时资源目录已恢复。
- 实际 npm 安装后的 bin 命令输出 CLI 与内置运行时均为 `1.10.0`。
- 解包后核对 `main.cjs` 内含 engine 执行循环、上下文管理器、结构化记忆与 PRIME 模块，也含最新 `memorySelectionTimeoutMs` / `memorySelectionTokens`、分开的 `contextSummaryModelTokens` 生成预算与保留预算、选择请求的 `temperature: 0`、`summarizeContext` 和 `unmanagedWritePath` 受管写入保护；没有动态加载仓库 `engine/src` 的裸 `require` / `import`。
- 包中没有预期 `dist/` 和 npm 元数据之外的源码、测试、临时配置或运行数据。

安装检查使用单独的 `QUETZAL_HOME`、`XDG_CONFIG_HOME` 和 `XDG_RUNTIME_DIR`；`PATH` 中的隔离 `systemctl` / `loginctl` 明确拒绝服务管理命令。仅设置前述目录或 D-Bus 地址不能保证隔离用户服务，不能省略这层保护。

最终包在新的合成家目录中完成 CLI 安装，再以前台子进程启动包内真实 `main.cjs` 与 Linux 适配器。`/health` 返回 `version=1.10.0`、`safeMode=false`，网页根入口返回 HTTP 200 和 Flutter 页面。合成配置哨兵及灵魂笔记保留，未安装用户服务；结束后临时运行时进程全部退出。检查期间保留 STOP，未配置真实模型或灵魂远端。

另执行了生产语义选择器测试 `runtime/test/memory-semantic.test.ts`，11 项全部通过，包含配置 100 ms 时不配合 signal 的模型等待超时，并回退到已过 scope 门禁的词面候选；测试显式保活，未把 Node 提前退出当作超时通过。另核对配置 1600 的输出预算实际传入模型，预算预留包含配置上限，完成后按模型报告的 usage 计账，返回的跨用户键仍被拒绝；输出 usage 为 256 而正文为空时，alias 选择降级为词面零命中，没有被记作语义选择成功。runtime 类型检查通过。

另有受管工具专项 7 项、记忆 / 上下文联合 38 项及 PRIME 宿主专项 12 项在前述源码修复阶段通过。最终重建仅再次核对包内标识、npm 入口与隔离健康 / 网页启动，没有重复完整升级回滚，也没有在最终验收中触碰真实用户服务。

## 升级与回退证据

最终重打包之前已执行以下安装器流程；之后调整了宿主摘要、语义选择超时与输出预算，以及受管写入 / 命令沙箱边界，未调整 CLI 安装器，因此没有重复全部流程：

1. 现存的 **1.9.4 本地开发包** → 1.10.0 本地包 → 手动 `rollback` 到 1.9.4 → 再次 `rollback` 到 1.10.0。每次启动真实运行时，健康接口版本与当前指针一致，合成配置和灵魂笔记保留。该基线没有 Web，且不是从正式 Release 获取的签名资产。
2. 在临时包中注入启动即退出的故障。独立服务模拟器只管理临时家目录中的子进程；新版本 40 秒不健康后，真实 CLI 安装器自动切回 1.9.4，并重新启动健康的旧版运行时。

第二项证明健康失败时的安装编排和指针回退，不证明真实 systemd 服务重启、开机自启或平台权限行为。

## 操作偏差与限制

首次安装试验只设置临时目录和一个不存在的 D-Bus 地址，`systemctl --user` 仍连接既有用户实例，导致原用户服务被重启。原服务单元、原家目录配置和灵魂数据没有被试验覆写；后续只读核对显示原服务为 active，ExecStart 仍使用原运行目录，健康接口可响应。临时单元已删除。之后的全部隔离检查使用明确的服务命令桩，没有再次操作真实服务。

没有在本机执行 Windows x64 / arm64 安装、PowerShell、提权、计划任务、Android、Linux arm64 / musl、真实 systemd 升级回退或发布后的一行安装工作流。现有 `.github/workflows/install-smoke.yml` 需要 Windows runner 和真实发布资产，本次没有触发它，也没有执行外部发布。

## Windows ARM CI 进程测试诊断

[CI 作业 115801091247](https://github.com/PlutoKeating/Project.Quetzal/actions/runs/38548706862/job/115801091247) 的 Windows 11 ARM / Node 24 测试共 408 项，395 项通过、1 项失败、12 项跳过；失败导致该作业没有执行构建。唯一失败是 `runtime/test/processes.test.ts` 将数字 PID 过滤误认为只能命中一个进程。

当前生产接口明确使用「命令行子串匹配或精确 PID 匹配」。日志中本测试进程的 PID 同时出现在另一个进程的命令参数里，因此返回两项符合接口，而不是 ARM 平台的运行时异常。修复只调整测试：过滤结果必须包含自身；新增携带父进程 PID 参数的合成 Node 子进程，验证两者同时命中、报告计数与输出行数一致，并在 finally 中结束子进程。没有更改生产过滤逻辑、没有跳过该测试，也没有降低发布门禁。

修复后的本机 `test/processes.test.ts` 为 5/5 通过，runtime 类型检查通过。Windows ARM 的修复验收仍需后续 CI 实际重新执行，本机 Linux 结果不能代替它。此修改仅涉及测试与记录，不改变上文生产包的代码基线和指纹。

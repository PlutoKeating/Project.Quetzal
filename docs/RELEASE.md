# 发版手册（Release）

本文是 `Quetzalcoatl` 的唯一发版操作手册：如何打 tag、需要哪个 Secret、每个资产是什么、
如何独立验证签名，以及出问题时如何回滚。自动化定义在
`.github/workflows/release.yml`，本地可先按第 6 节完整演练。

> 红线：打 tag、推送 tag、创建 Release 都是**维护者**动作。任何自动化都不得代替人工确认
> `main` 已通过 CI；`release.yml` 本身不做 `git push`。

## 1. 信任根与所需 Secret

| 项目 | 值 / 位置 |
| --- | --- |
| 签名算法 | Ed25519（PKCS#8 PEM 私钥，`openssl pkeyutl -sign -rawin`） |
| GitHub Secret | `RELEASE_SIGNING_KEY`（仓库 Settings → Secrets and variables → Actions） |
| 内置公钥（安装器） | `QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8`（raw 32 字节 base64url） |
| 公钥落点 | `scripts/install.sh`、`scripts/install.ps1`、官网 release-signing 文档 |

- Secret 只注入 `sign` job；该 job 也是唯一拥有 `contents: write` 的 job。
- `scripts/gen-sums.sh` 把 `RELEASE_SIGNING_KEY` 写入 `0600` 临时文件后使用，不打印私钥。
- **发版前的信任根硬门禁**：`sign` job 先运行 `scripts/check-release-key.sh`，把 Secret 派生
  的 raw-32 公钥与 `scripts/install.sh`、`scripts/install.ps1`、`scripts/install.src.ps1`
  内置的生产公钥逐字比较，不一致立即失败。`gen-sums.sh --check` 只能证明签名没坏，这一步
  才能证明「用户机器上的安装器认得这把钥匙」。
- 签名完成后、上传前，`sign` job 还会用**未做任何 test-pubkey 覆盖**的
  `scripts/install.sh` 从本地静态服务安装 `dist/` 里的真实 `linux-x64` 包，并断言
  `qz --version` 精确等于发布版本。信任根分叉或资产布局漂移都会在这一步失败。
- **轮换密钥**必须同一次变更内同步：Secret、`scripts/install.sh`、`scripts/install.ps1`、
  `scripts/install.src.ps1`、官网文档，以及已发布 Release 的说明。旧公钥无法验证新签名，
  混用会让所有安装失败。
- 私钥绝不入库；本地演练必须用一次性的 throwaway key（第 6 节）。

## 2. 发版前检查

1. `main` 的 CI 全绿（见第 7 节矩阵）。
2. `CHANGELOG.md` 顶部有 `## <version>` 小节；`release.yml` 会把它作为 Release 正文，
   缺失或为空时 `sign` job 直接失败。
3. 版本一致性：`Cargo.toml` 的 `[workspace.package] version` 必须与待发版本**完全相等**。
   - 推 tag 时若不相等，`sign` job 直接失败，绝不把 `2.0.0-alpha.1` 的二进制标成 `v2.0.0`。
   - `workflow_dispatch` 演练只告警，并跳过「从 dist 安装」那一步（版本号不同无法通过精确版本检查）。
   - 安装器的健康检查同样按 `v?` 锚定的完整版本令牌比较：`qz 2.0.0-alpha.1` 不能满足 `2.0.0`。
4. Rust 工具链由 `rust-toolchain.toml` 固定（`1.99.1`，含 clippy/rustfmt）；CI 的
   `rustup show` 会读取该文件，本地与 CI 使用同一版本，避免 clippy 漂移。`Cargo.toml` 的
   `rust-version = "1.91"` 是 MSRV 下限，不是 CI 使用的版本。
5. 本机可复现的宿主门禁（与 CI 的 `rust` job 等价）：

   ```bash
   cargo deny check licenses bans sources
   cargo fmt --all -- --check
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   bash scripts/tests/install_verify_sig.test.sh
   bash scripts/tests/gen_sums.test.sh
   bash scripts/tests/docs_links.test.sh
   ```

## 3. 打 tag 与触发

```bash
git checkout main
git pull --ff-only
git tag -s v2.0.0 -m "Quetzalcoatl 2.0.0"   # 签名 tag；无 GPG 时由维护者决定是否用轻量 tag
git push origin v2.0.0                       # 需维护者显式授权
```

- `push` tag `v*`：构建 + 签名 + 创建 GitHub Release + 上传资产。版本含 `-`（如
  `v2.0.0-alpha.1`）时自动以 `--prerelease` 创建，并且 `/api/releases/latest` 仍可解析到它
  （见第 7 节的官网选择规则）。
- `workflow_dispatch`（输入 `version`，例如 `2.0.0`）：同一套构建与签名，**不创建 Release**，
  资产以 `release-bundle` workflow artifact 形式保留 30 天，用于演练。
- 演练同样需要 `RELEASE_SIGNING_KEY`；没有 Secret 时 `sign` job 会以明确错误失败，
  绝不产出未签名资产。

## 4. 资产清单（名称稳定，安装器依赖）

`arch` 取值固定为 `x64` / `arm64`（与 `scripts/install.sh` 的架构识别一致；
`x64` 对应 Go 的 `amd64`）。

| 资产 | 内容 | 消费者 |
| --- | --- | --- |
| `quetzalcoatl-<version>-linux-x64.tar.gz` | `bin/qz`、`bin/quetzalcoatld`、`bin/quetzalcoatl-sandbox-exec` | `scripts/install.sh`（Linux x86_64） |
| `quetzalcoatl-<version>-linux-arm64.tar.gz` | 同上，aarch64 构建 | `scripts/install.sh`（Linux arm64） |
| `quetzalcoatl-<version>-hub-linux-x64` | `CGO_ENABLED=0` 静态 `quetzalcoatl-hub` | Hub 运维手工部署 |
| `quetzalcoatl-<version>-hub-linux-arm64` | 同上，arm64 | Hub 运维手工部署 |
| `quetzalcoatl-<version>-linux-desktop-x64.tar.gz` | `bin/quetzalcoatl-desktop`、`share/applications/*.desktop`、`share/icons/...` | Linux 桌面用户手工安装 |
| `quetzalcoatl-<version>-web.tar.gz` | `surfaces/web` 的 `npm run build` 输出全部静态文件（根为 `index.html`） | 自托管 Web 控制台 |
| `SHA256SUMS` | 每个资产一行 `<sha256>  <文件名>`，外加 `commit <40-hex> <tag>` | 安装器、镜像 Worker、人工复核 |
| `SHA256SUMS.sig` | `SHA256SUMS` 的 Ed25519 签名（base64 文本） | 安装器、人工复核 |

- **Windows 不发二进制资产**：`surfaces/windows`（最小治理外壳）目前只有源码与 CI 构建证据，exe/msix 代码
  签名证书接入前不发布 Windows 安装包。Release 正文里会说明这一点。
- **macOS 本轮也不发二进制资产**：SwiftPM 构建由 `macos-14` CI 验证，但 Developer ID 签名
  与公证未接入；`v2.0.0-alpha.1` 的 Release 只有 Linux/Web/Hub 资产。
- **Web 资产是治理面**：`quetzalcoatl-<version>-web.tar.gz` 是守护进程同源托管的治理面静态资源（`qz open` 打开）。
- **不发布 npm**：V2 没有 npm 包；`release.yml` 不包含任何 npm publish 步骤。
  官网 Worker 的 npm 版本封顶在「包不存在」时视为**无上限**（`capReleases` 收到空版本即原样
  返回），不会因为 npm 缺失而隐藏 GitHub 上已签名的版本。

### Linux 桌面包的安装方式

```bash
tar -xzf quetzalcoatl-<version>-linux-desktop-x64.tar.gz -C "$HOME/.local"
# 得到 ~/.local/bin/quetzalcoatl-desktop 与 share/applications、share/icons
export PATH="$HOME/.local/bin:$PATH"
quetzalcoatl-desktop --self-test --demo-rows   # 无头自检；正常启动直接运行 quetzalcoatl-desktop
```

桌面端依赖目标发行版的 `libadwaita-1 >= 1.9`（见第 7 节系统库下限）。

### 官网 `/api/releases/latest` 的选择规则

Worker 与下载页共用 `website/shared/releases.ts`：只有同时满足
① 至少一个资产名以 `quetzalcoatl-` 开头（本产品品牌，排除同仓库 V1 的 `v1.11.0`）
② 带 `SHA256SUMS` + `SHA256SUMS.sig` 的发布才会出现。`pickLatest` 优先最新正式版；
没有任何正式版时回退到最新预发布版并在 JSON/页面标注 `prerelease: true`。
因此 `v2.0.0-alpha.1` 在首个稳定版之前也可被 `scripts/install.sh` 的默认 latest 安装。

## 5. 验证签名（任何人、不依赖 GitHub 账号）

```bash
TAG=v2.0.0
ASSET=quetzalcoatl-2.0.0-linux-x64.tar.gz
BASE="https://github.com/PlutoKeating/Project.Quetzal/releases/download/$TAG"

curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.sig"
curl -fsSLO "$BASE/$ASSET"

# 内置公钥 -> SPKI PEM（raw 32 字节前加 302a300506032b6570032100）
PUB=QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8
python3 - "$PUB" > release.pub <<'PY'
import base64, sys
raw = base64.urlsafe_b64decode(sys.argv[1] + "=" * (-len(sys.argv[1]) % 4))
der = bytes.fromhex("302a300506032b6570032100") + raw
print("-----BEGIN PUBLIC KEY-----")
print(base64.b64encode(der).decode())
print("-----END PUBLIC KEY-----")
PY

openssl base64 -d -A -in SHA256SUMS.sig -out SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey release.pub -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig.bin

grep "  $ASSET\$" SHA256SUMS > "$ASSET.sha256"
sha256sum -c "$ASSET.sha256"      # macOS: shasum -a 256 -c "$ASSET.sha256"
```

顺序必须是**先验签、再核哈希**：反过来的话，不可信的清单就能定义「什么算正确」。
`release.yml` 在上传前执行 `scripts/gen-sums.sh --check`，对签名、commit 行与逐文件哈希
做同一套校验；任何不一致都会让 job 失败。

## 6. 本地演练（不推送、不建 Release）

演练使用与 CI 相同的命令，只把签名密钥换成一次性密钥，产物落在仓库外的临时目录
（避免 `dist/` 变成脏文件）。

```bash
set -euo pipefail
mkdir -p /tmp/opencode
WORK=$(mktemp -d /tmp/opencode/qz-release-dryrun.XXXXXX)
VERSION=2.0.0
DIST="$WORK/dist"
mkdir -p "$DIST"

# 1) 一次性 Ed25519 密钥
openssl genpkey -algorithm ed25519 -out "$WORK/release.pem"
PUB=$(openssl pkey -in "$WORK/release.pem" -pubout -outform DER \
  | tail -c 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 2) CLI 包（与 release.yml 的 linux-x64 job 相同）
cargo build --release -p quetzalcoatl-daemon --bins \
  -p quetzalcoatl-sandbox --bin quetzalcoatl-sandbox-exec
STAGE="$WORK/stage/quetzalcoatl-$VERSION-linux-x64"
mkdir -p "$STAGE/bin"
cp target/release/qz \
   target/release/quetzalcoatld \
   target/release/quetzalcoatl-sandbox-exec "$STAGE/bin/"
chmod 0755 "$STAGE/bin/"*
tar -czf "$DIST/quetzalcoatl-$VERSION-linux-x64.tar.gz" -C "$STAGE" .

# 3) Hub / 桌面 / Web 资产（glibc 目标机才需要 GTK 开发包）
(cd hub && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" \
  -o "$DIST/quetzalcoatl-$VERSION-hub-linux-x64" ./cmd/quetzalcoatl-hub)
cargo build -p quetzalcoatl-desktop --release
DS="$WORK/stage/quetzalcoatl-$VERSION-linux-desktop-x64"
mkdir -p "$DS/bin" "$DS/share/applications" "$DS/share/icons/hicolor/scalable/apps"
cp target/release/quetzalcoatl-desktop "$DS/bin/"
cp surfaces/linux/resources/org.quetzalcoatl.Desktop.desktop "$DS/share/applications/"
cp surfaces/linux/resources/org.quetzalcoatl.Desktop.svg \
  "$DS/share/icons/hicolor/scalable/apps/"
tar -czf "$DIST/quetzalcoatl-$VERSION-linux-desktop-x64.tar.gz" -C "$DS" .
(cd surfaces/web && npm ci && npm run build && tar -czf \
  "$DIST/quetzalcoatl-$VERSION-web.tar.gz" -C dist .)

# 4) 签名 + 自校验
bash scripts/gen-sums.sh "$DIST" --tag "v$VERSION" --key "$WORK/release.pem"
bash scripts/gen-sums.sh "$DIST" --tag "v$VERSION" --check --key "$WORK/release.pem"

# 5) 用本地 HTTP 假发布源证明发布布局可安装
mkdir -p "$WORK/srv/v$VERSION"
cp "$DIST"/* "$WORK/srv/v$VERSION/"
python3 -m http.server 18080 --bind 127.0.0.1 --directory "$WORK/srv" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
BASE=http://127.0.0.1:18080/v$VERSION
H="$WORK/home"
HOME="$H" QZ_PREFIX="$H/prefix" QUETZALCOATL_HOME="$H/qzhome" \
  QZ_RELEASE_BASE="$BASE" QZ_TEST_RELEASE_PUBKEY="$PUB" QZ_ALLOW_TEST_PUBKEY=1 \
  QZ_SKIP_SERVICE=1 bash scripts/install.sh --version "$VERSION" --no-desktop
"$H/prefix/bin/qz" --version
```

预期：`gen-sums.sh` 打印公钥 sha256 指纹与资产数量；`--check` 打印
`every artifact matches SHA256SUMS`；安装器输出签名/sha256 已验证并安装成功；
`qz --version` 能正常返回。清理：`kill` 掉 HTTP server 后 `rm -rf "$WORK"`。

## 7. CI 矩阵与已知限制

| Job | Runner | 内容 | 门禁 |
| --- | --- | --- | --- |
| `rust` | ubuntu-26.04 | `cargo deny`、`fmt`、`clippy -D warnings`、`xvfb-run cargo test --workspace` | 阻断 |
| `go` | ubuntu-24.04 | `CGO_ENABLED=0 go build`、`go vet`、`CGO_ENABLED=1 go test -race`（race 需要 cgo） | 阻断 |
| `web` | ubuntu-24.04 | `surfaces/web`（typecheck + vitest + Playwright chromium）与 `website`（typecheck + vitest + prerender build）、文档链接、安装器与清单测试 | 阻断 |
| `linux-desktop` | ubuntu-26.04 | GTK4 release 构建 + `dynamic_link_and_ui`（ELF 动态链接 LGPL-2.1 + 无头 UI 契约） | 阻断 |
| `macos` | macos-14 | 最小治理外壳 `swift build` | 阻断 |
| `windows` | windows-2022 | 最小治理外壳 WinUI 3 App 构建；只容忍 runner 缺 Appx/PRI 任务这一已知缺口，C#/XAML/MSBuild 编译器错误一律阻断 | 阻断（窄例外） |
| `mobile` | — | `if: false` 占位，不运行、不声称通过 | 不适用 |

为什么 Rust 两个 job 用 ubuntu-26.04：`surfaces/linux` 的 `libadwaita` crate 开启了
`v1_9` 特性（`AGENTS.md` §4.1 要求 libadwaita >= 1.9），Ubuntu 24.04 软件源只有 1.5，
`pkg-config` 探测会直接失败。26.04 与仓库实际验证机一致（libadwaita 1.9.1 / GTK 4.22）。
Go / Web 等不依赖 GTK 的 job 仍固定在 ubuntu-24.04。

已知限制（诚实记录）：

- **Linux 桌面包的系统库下限**：`quetzalcoatl-<version>-linux-desktop-x64.tar.gz` 在
  ubuntu-26.04 上构建，要求目标发行版提供 `libadwaita-1 >= 1.9` 与兼容的 GTK 4 运行时
  （如 Ubuntu 26.04+、Fedora 42+）。CLI/Hub 包在 ubuntu-24.04 构建，保持更低的 glibc 下限。
- **移动端未交付**：iOS / Android 源码由计划 Task 5.1 / 5.2 落地；在源码出现前不存在
  可运行的移动端 job。`Deferred:` 到对应任务完成。
- **Windows App 的 Appx/PRI 依赖**：WinUI 3 App 需要 VS 2022 的
  `Microsoft.Build.AppxPackage.dll`。`windows-2022` 镜像通常自带 UniversalBuildTools，
  因此 CI 会真实构建；仅当失败日志**只**包含该缺失任务（无 `error CS####` / `XLS####` /
  `WMC####` / `XamlCompiler` / `error MSB####`）时才判定为已知环境缺口并给出警告，
  否则按真实编译错误失败。
- **Windows arm64 构建 `Deferred:`**：本仓库没有 Windows arm64 硬件/VM，WinUI 3 的
  arm64 交叉构建还依赖 arm64 MSIX 签名资产。当前只验证 x64 源码；恢复 arm64 验证机后
  再补 `Platform=ARM64` job（不改 `Platforms=x64` 的现有工程契约）。
- **arm64 CLI/Hub 构建**运行在 GitHub 托管的 `ubuntu-24.04-arm` 上；不再使用 qemu 交叉
  编译，因此没有交叉工具链漂移。若该 runner 标签在组织策略下不可用，需改为自托管 arm64
  runner 或启用 `cross`（会新增构建依赖，需单独评审）。
- **`cargo-deny` 未固定版本**：仓库没有 `cargo-deny` 的版本锁文件，CI 安装当前最新版。
  规则本身由 `deny.toml` 固定；若上游改变默认检查语义，按 PR 修复而不是放行。
- **Rust 工具链固定**：`rust-toolchain.toml` 固定 `1.99.1`（含 clippy/rustfmt），CI 的
  `rustup show` 读取同一文件。`Cargo.toml` 的 `rust-version = "1.91"` 只是 MSRV 下限；
  把 CI 钉到 1.91.0 需要独立 MSRV 验证（当前依赖图要求更高），`Deferred:` 到依赖图收敛后。
- **workflow 语法校验**：本机没有 `actionlint`；两个工作流已通过 YAML 解析与 SchemaStore
  `github-workflow.json` 的 JSON Schema 校验，首次推送后由 GitHub 实际执行复核。
- **Release 资产不包含 Windows/macOS 安装包**：代码签名与 Apple 公证未接入，见第 4 节。

## 8. 回滚

1. **安装器自动回滚**：`scripts/install.sh` 在新版本 `qz --version` 健康检查失败时，会用
   `$QUETZALCOATL_HOME/backup/` 恢复上一个版本的 `bin/` 并退出非零；`--uninstall --purge`
   会删除二进制、服务与状态目录。
2. **撤回错误 Release**：
   - 先 `gh release edit <tag> --draft`（或删除 Release 资产），避免镜像继续分发；
   - 重新构建并发布修正版本（`v2.0.1`），不要静默覆盖同版本号的资产——`SHA256SUMS` 的
     `commit` 行会让旧清单与新源码对不上；
   - 若必须重传同 tag（仅限 tag 尚未被用户广泛缓存，且维护者二次确认），
     `release.yml` 的 `gh release upload --clobber` 会复用同一 tag，但必须在 Release 正文
     里写明重传原因与旧的 `SHA256SUMS` 指纹。
3. **密钥疑似泄露**：立即停止发版，按第 1 节同步轮换公钥与 Secret，发布安全公告；旧版本
   仍可用旧公钥验证，但不再接受新签名。
4. **镜像缓存**：官网 Worker 以 GitHub Release 的 digest 为准；撤回 Release 后镜像会在下一次
   同步失败并停止提供该版本，不需要手工清缓存。

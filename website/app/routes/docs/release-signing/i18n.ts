import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "发布签名与校验",
    doc: {
      title: "发布签名与校验",
      description: "Ed25519 公钥、SHA256SUMS 格式、自己动手验签的命令，以及官网镜像的 digest 校验。",
      lead:
        "每个发布都用同一把 Ed25519 密钥签名清单。公钥写死在安装器、Windows 安装脚本与这份文档里——换掉镜像、换掉 GitHub 账号，都换不掉公钥。",
      blocks: [
        { kind: "h2", id: "key", text: "发布公钥" },
        {
          kind: "p",
          text: "Ed25519，原始 32 字节公钥的 base64url（无填充）：",
        },
        {
          kind: "code",
          title: "public key",
          text: `QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8`,
        },
        {
          kind: "p",
          text:
            "私钥只存在于 GitHub Actions Secret `RELEASE_SIGNING_KEY`（PKCS#8 PEM），不在仓库、不在任何构建产物里。轮换密钥时需要同时更新 `scripts/install.sh`、`scripts/install.ps1` 与本文档，并保留旧公钥一个版本的过渡期。",
        },
        { kind: "h2", id: "assets", text: "资产与清单" },
        {
          kind: "table",
          head: ["资产", "内容"],
          rows: [
            ["`quetzalcoatl-<版本>-linux-x64.tar.gz`", "`bin/qz`、`bin/quetzalcoatld`、`bin/quetzalcoatl-sandbox-exec`"],
            ["`quetzalcoatl-<版本>-macos-arm64.tar.gz`", "同上（Intel 为 `macos-x64`）"],
            ["`quetzalcoatl-<版本>-windows-x64.zip`", "同上，可执行文件带 `.exe`"],
            ["`SHA256SUMS`", "每个资产一行 `<sha256>  <文件名>`，外加一行 `commit <40 位提交> <tag>`"],
            ["`SHA256SUMS.sig`", "`SHA256SUMS` 的 Ed25519 签名，base64 文本"],
          ],
        },
        {
          kind: "code",
          title: "SHA256SUMS",
          text: `9f2c…（64 位十六进制）  quetzalcoatl-0.1.0-linux-x64.tar.gz
1a77…（64 位十六进制）  quetzalcoatl-0.1.0-macos-arm64.tar.gz
commit 3f9a1c0d2e4b5a69788796a5b4c3d2e1f0011223 v0.1.0`,
        },
        {
          kind: "p",
          text:
            "`commit` 行把版本钉在源码提交上。安装器不只看哈希，也要求这一行的 tag 与要装的版本一致——防止把 A 版本的清单配 B 版本的二进制。",
        },
        { kind: "h2", id: "verify", text: "自己验证（Linux / macOS）" },
        {
          kind: "code",
          title: "shell",
          text: `TAG=v0.1.0
ASSET=quetzalcoatl-0.1.0-linux-x64.tar.gz
BASE="https://quetzal.plutokeating.beer/dl/$TAG"

curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.sig"
curl -fsSLO "$BASE/$ASSET"

# 公钥 -> SPKI PEM（原始 32 字节前加 302a300506032b6570032100）
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
openssl pkeyutl -verify -pubin -inkey release.pub -rawin \\
  -in SHA256SUMS -sigfile SHA256SUMS.sig.bin

# 只核对这一个资产（commit 行不是 sha256sum 的格式）
grep "  $ASSET\\$" SHA256SUMS > "$ASSET.sha256"
sha256sum -c "$ASSET.sha256"      # macOS：shasum -a 256 -c "$ASSET.sha256"`,
        },
        {
          kind: "note",
          text:
            "签名校验必须放在哈希校验之前。反过来做，等于让不可信的清单决定「什么算正确」。安装器与上面的命令都是先验签、再对哈希。",
        },
        { kind: "h2", id: "windows", text: "Windows" },
        {
          kind: "p",
          text:
            "Windows PowerShell 5.1 与 .NET Framework 没有 Ed25519 API，所以 `install.ps1` 内置了一份 RFC 8032 的验签实现（`Test-Ed25519`，基于 `System.Numerics.BigInteger`，无外部依赖）。它先用它验证 `SHA256SUMS.sig`，再用 `Get-FileHash` 核对 zip。要复核，读 `scripts/install.ps1` 里的这个函数即可——没有黑盒。",
        },
        { kind: "h2", id: "mirror", text: "官网镜像与 digest" },
        {
          kind: "p",
          text:
            "下载地址默认走本 Worker：`/dl/<tag>/<asset>`。Worker 只代理本仓库、符合命名规则的资产，并在转发时用 GitHub 发布 JSON 里的 `digest` 核对 SHA-256：小的清单文件整体校验，大的二进制边转发边算、扣住最后一块，核对通过才放出。不符就让流出错，且在 Cloudflare 边缘不缓存。核对通过的资产缓存 7 天（按 tag 不可变）。",
        },
        {
          kind: "ul",
          items: [
            "`/api/releases` 与 `/api/releases/latest` 是 GitHub 发布接口的镜像，资产地址改写成 `/dl/…`，原地址保留在 `github_download_url`。",
            "发布列表按 npm 上引导包的版本封顶，永远不会推荐一个 npm 通道还装不到的版本。",
            "上游取不到发布 JSON、无法核对 digest 时，Worker 直接 502 拒绝转发，而不是送出一份未经核对的字节；安装器与客户端会改走 GitHub 直连，签名校验仍是最后一道门。",
          ],
        },
        { kind: "h2", id: "not-signed", text: "不签名、不发布的东西" },
        {
          kind: "ul",
          items: [
            "没有「跳过校验」的开关，也没有 TOFU（首次使用即信任）模式。",
            "不提供未签名的夜间构建下载；要试新代码请从源码构建。",
            "镜像方无法替换资产：换掉字节，哈希与签名至少有一道会失败。",
          ],
        },
      ],
    },
  },
  en: {
    metaTitle: "Release signing and verification",
    doc: {
      title: "Release signing and verification",
      description: "The Ed25519 public key, the SHA256SUMS format, commands to verify by hand, and how the site mirror checks GitHub digests.",
      lead:
        "Every release signs its manifest with one Ed25519 key. The public key is baked into the installers, the Windows script and this page. Swapping a mirror or a GitHub account cannot swap the key.",
      blocks: [
        { kind: "h2", id: "key", text: "Release public key" },
        { kind: "p", text: "Ed25519, base64url of the raw 32-byte public key (no padding):" },
        {
          kind: "code",
          title: "public key",
          text: `QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8`,
        },
        {
          kind: "p",
          text:
            "The private key exists only as the GitHub Actions secret `RELEASE_SIGNING_KEY` (PKCS#8 PEM). It is not in the repository and not in any build artifact. Rotating it means updating `scripts/install.sh`, `scripts/install.ps1` and this page, and keeping the old key valid for one release window.",
        },
        { kind: "h2", id: "assets", text: "Assets and manifest" },
        {
          kind: "table",
          head: ["Asset", "Contents"],
          rows: [
            ["`quetzalcoatl-<version>-linux-x64.tar.gz`", "`bin/qz`, `bin/quetzalcoatld`, `bin/quetzalcoatl-sandbox-exec`"],
            ["`quetzalcoatl-<version>-macos-arm64.tar.gz`", "The same (Intel is `macos-x64`)"],
            ["`quetzalcoatl-<version>-windows-x64.zip`", "The same, executables with `.exe`"],
            ["`SHA256SUMS`", "One `<sha256>  <file>` line per asset plus a `commit <40-hex> <tag>` line"],
            ["`SHA256SUMS.sig`", "The Ed25519 signature of `SHA256SUMS`, base64 text"],
          ],
        },
        {
          kind: "code",
          title: "SHA256SUMS",
          text: `9f2c… (64 hex chars)  quetzalcoatl-0.1.0-linux-x64.tar.gz
1a77… (64 hex chars)  quetzalcoatl-0.1.0-macos-arm64.tar.gz
commit 3f9a1c0d2e4b5a69788796a5b4c3d2e1f0011223 v0.1.0`,
        },
        {
          kind: "p",
          text:
            "The `commit` line pins the release to a source commit. The installer checks not only hashes but that this tag matches the version being installed, so a manifest from version A cannot be paired with a binary from version B.",
        },
        { kind: "h2", id: "verify", text: "Verify by hand (Linux / macOS)" },
        {
          kind: "code",
          title: "shell",
          text: `TAG=v0.1.0
ASSET=quetzalcoatl-0.1.0-linux-x64.tar.gz
BASE="https://quetzal.plutokeating.beer/dl/$TAG"

curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.sig"
curl -fsSLO "$BASE/$ASSET"

# public key -> SPKI PEM (DER prefix 302a300506032b6570032100 + raw 32 bytes)
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
openssl pkeyutl -verify -pubin -inkey release.pub -rawin \\
  -in SHA256SUMS -sigfile SHA256SUMS.sig.bin

# check just this asset (the commit line is not sha256sum format)
grep "  $ASSET\\$" SHA256SUMS > "$ASSET.sha256"
sha256sum -c "$ASSET.sha256"      # macOS: shasum -a 256 -c "$ASSET.sha256"`,
        },
        {
          kind: "note",
          text:
            "Verify the signature before the hash. Doing it the other way round lets an untrusted manifest decide what correct means. The installer and the commands above always verify first and hash second.",
        },
        { kind: "h2", id: "windows", text: "Windows" },
        {
          kind: "p",
          text:
            "Windows PowerShell 5.1 and .NET Framework have no Ed25519 API, so `install.ps1` carries an RFC 8032 verifier (`Test-Ed25519`, built on `System.Numerics.BigInteger`, no external dependency). It checks `SHA256SUMS.sig` with it, then checks the zip with `Get-FileHash`. Read that function in `scripts/install.ps1` — there is no black box.",
        },
        { kind: "h2", id: "mirror", text: "The site mirror and digests" },
        {
          kind: "p",
          text:
            "Downloads default to this Worker: `/dl/<tag>/<asset>`. It relays only this repository's correctly named assets, and checks each stream against the `digest` recorded in GitHub's release JSON: small manifests are buffered and checked whole; large binaries are hashed while streaming with the final chunk held back until the digest matches. A mismatch errors the stream and is never cached at Cloudflare's edge. Verified assets are cached for seven days (tags are immutable).",
        },
        {
          kind: "ul",
          items: [
            "`/api/releases` and `/api/releases/latest` mirror GitHub's release API, rewriting asset URLs to `/dl/…` while keeping the original as `github_download_url`.",
            "The list is capped by the npm bootstrapper's published version, so it never advertises a release that channel cannot install yet.",
            "When the upstream release JSON is unavailable and the digest cannot be checked, the Worker answers 502 instead of serving unverified bytes. The installer and clients fall back to GitHub directly; signature verification remains the last gate.",
          ],
        },
        { kind: "h2", id: "not-signed", text: "What is not signed or published" },
        {
          kind: "ul",
          items: [
            "There is no skip-verification switch and no trust-on-first-use mode.",
            "Unsigned nightly downloads are not offered; build from source to try unreleased code.",
            "A mirror cannot substitute an asset: change the bytes and either the hash or the signature fails.",
          ],
        },
      ],
    },
  },
};

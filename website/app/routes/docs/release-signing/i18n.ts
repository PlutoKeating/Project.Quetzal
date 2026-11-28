import { SITE_ORIGIN } from "~/i18n/core";
import type { Lang } from "~/i18n/core";
import type { Messages } from "~/lib/content";

// 与 scripts/install.sh 里的 RELEASE_PUBKEY 是同一把钥匙；轮换时两处一起改。
export const RELEASE_PUBKEY = "QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8";

const verify = (lang: Lang): string => {
  const c =
    lang === "zh"
      ? { version: "换成你要验证的版本", pem: "公钥 -> PEM（原始 32 字节前加一段固定前缀）", sig: "先验证清单的签名", one: "再核对这一个安装包", mac: "macOS 上用 shasum -a 256 -c" }
      : { version: "replace with the version you are verifying", pem: "public key -> PEM (a fixed prefix in front of the raw 32 bytes)", sig: "first verify the manifest signature", one: "then check this one package", mac: "on macOS use shasum -a 256 -c" };
  return `VERSION=2.0.0-alpha.4        # ${c.version}
ASSET=quetzalcoatl-$VERSION-linux-x64.tar.gz
BASE="${SITE_ORIGIN}/dl/v$VERSION"

curl -fsSLO "$BASE/SHA256SUMS"
curl -fsSLO "$BASE/SHA256SUMS.sig"
curl -fsSLO "$BASE/$ASSET"

# ${c.pem}
PUB=${RELEASE_PUBKEY}
python3 - "$PUB" > release.pub <<'PY'
import base64, sys
raw = base64.urlsafe_b64decode(sys.argv[1] + "=" * (-len(sys.argv[1]) % 4))
der = bytes.fromhex("302a300506032b6570032100") + raw
print("-----BEGIN PUBLIC KEY-----")
print(base64.b64encode(der).decode())
print("-----END PUBLIC KEY-----")
PY

# ${c.sig}
openssl base64 -d -A -in SHA256SUMS.sig -out SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey release.pub -rawin \\
  -in SHA256SUMS -sigfile SHA256SUMS.sig.bin

# ${c.one}
grep "  $ASSET\\$" SHA256SUMS > "$ASSET.sha256"
sha256sum -c "$ASSET.sha256"      # ${c.mac}`;
};

export const messages: Messages = {
  zh: {
    metaTitle: "发布签名与校验",
    doc: {
      title: "发布签名与校验",
      lead: "每个发布物都由同一把密钥签名。公钥写在安装器里，也写在这一页；换掉下载源，换不掉公钥。",
      blocks: [
        { kind: "h2", id: "key", text: "发布公钥" },
        { kind: "cmd", label: "Ed25519，原始 32 字节的 base64url：", head: "Public key", text: RELEASE_PUBKEY },
        { kind: "h2", id: "manifest", text: "清单里有什么" },
        { kind: "p", text: "每个发布带一份清单和它的签名。安装器只信清单的签名；安装包对不对，由签过名的清单说了算。" },
        {
          kind: "table",
          head: ["文件", "内容"],
          rows: [
            ["`SHA256SUMS`", "每个安装包一行校验值，外加一行把这个版本钉在源码的某一次提交上"],
            ["`SHA256SUMS.sig`", "这份清单的签名"],
            ["`quetzalcoatl-<版本>-linux-x64.tar.gz`", "Linux x64 的安装包；arm64 同理"],
          ],
        },
        { kind: "h2", id: "verify", text: "自己动手验证" },
        { kind: "cmd", label: "Linux 与 macOS：", head: "Terminal", text: verify("zh") },
        { kind: "note", text: "先验签名，再核对校验值。顺序反过来，等于让一份还没验证过的清单决定什么算正确。安装器走的也是这个顺序。" },
        { kind: "h2", id: "mirror", text: "本站的下载地址" },
        { kind: "p", text: "安装包默认经本站下载。本站在转发每个文件时再核对一次校验值：对不上就中断，不把它交给你。即使本站被换掉，签名这一关仍然在你的机器上。" },
        { kind: "h2", id: "never", text: "没有的东西" },
        {
          kind: "ul",
          items: ["没有跳过校验的开关。", "没有「第一次用就默认信任」的模式。", "不提供未签名的构建。想试新代码，请从源码构建。"],
        },
      ],
    },
  },
  en: {
    metaTitle: "Release signing",
    doc: {
      title: "Release signing",
      lead: "Every release is signed with the same key. The public key is written into the installer and onto this page; replacing the download source does not replace the key.",
      blocks: [
        { kind: "h2", id: "key", text: "Release public key" },
        { kind: "cmd", label: "Ed25519, the raw 32 bytes as base64url:", head: "Public key", text: RELEASE_PUBKEY },
        { kind: "h2", id: "manifest", text: "What the manifest holds" },
        { kind: "p", text: "Each release ships a manifest and its signature. The installer trusts only the manifest signature; whether a package is right is decided by the signed manifest." },
        {
          kind: "table",
          head: ["File", "Contents"],
          rows: [
            ["`SHA256SUMS`", "one checksum line per package, plus one line that pins this version to a source commit"],
            ["`SHA256SUMS.sig`", "the signature of that manifest"],
            ["`quetzalcoatl-<version>-linux-x64.tar.gz`", "the Linux x64 package; arm64 follows the same pattern"],
          ],
        },
        { kind: "h2", id: "verify", text: "Verify it by hand" },
        { kind: "cmd", label: "Linux and macOS:", head: "Terminal", text: verify("en") },
        { kind: "note", text: "Verify the signature first, then the checksum. The other way round lets an unverified manifest decide what counts as correct. The installer follows the same order." },
        { kind: "h2", id: "mirror", text: "This site's download address" },
        { kind: "p", text: "Packages download through this site by default. The site checks each file's checksum again while relaying it: on a mismatch it stops and does not hand the file over. Even if this site were replaced, the signature check still happens on your machine." },
        { kind: "h2", id: "never", text: "What does not exist" },
        {
          kind: "ul",
          items: ["There is no switch to skip verification.", "There is no trust-on-first-use mode.", "There are no unsigned builds. To try new code, build from source."],
        },
      ],
    },
  },
};

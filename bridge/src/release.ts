// 程序目录的自我更新：只检出经发布签名核对过的正式版标签，不跟 main。
//   1. git fetch 标签，挑最新的正式版 vX.Y.Z（不含预发布）；
//   2. 下载这个版本的 SHA256SUMS 与 SHA256SUMS.sig（官网镜像在前，GitHub 在后；信任根是签名，不是下载来源）；
//   3. 用内置的发布公钥（ed25519）核对签名，从 SHA256SUMS 里读出 `commit <sha> <标签>`；
//   4. 本地 `git rev-parse <标签>^{commit}` 必须等于签名里的 sha，然后 `git checkout --detach <sha>`。
// 任何一步不满足都拒绝，程序目录保持原样。
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 发布签名公钥（ed25519，32 字节原始公钥的 base64url）。私钥只在 GitHub Actions 的发布流程里。 */
export const RELEASE_PUBLIC_KEY = "QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8";
const REPO = "PlutoKeating/Project.Quetzal";
export const releaseSources = (tag: string) => [
  `https://quetzal.plutokeating.beer/dl/${tag}/`,
  `https://github.com/${REPO}/releases/download/${tag}/`,
];
const MAX_BYTES = 1 << 20; // SHA256SUMS 只有几行，超过 1 MB 必有问题

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
/** 从标签列表里挑最新的正式版（vX.Y.Z，按数字比较；预发布与其他标签忽略）。 */
export function latestStable(tags: string[]): string | undefined {
  const v = tags.map((t) => t.trim()).filter((t) => STABLE.test(t));
  const n = (t: string) => t.match(STABLE)!.slice(1).map(Number);
  v.sort((a, b) => { const x = n(a), y = n(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return v.at(-1);
}

/** 核对签名并读出发布对应的提交。sums 是 SHA256SUMS 的原始字节，sig 是 SHA256SUMS.sig 的内容（base64）。失败抛出原因。 */
export function verifyRelease(sums: Uint8Array, sig: string, tag: string, publicKey = RELEASE_PUBLIC_KEY): string {
  const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  const s = sig.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error("SHA256SUMS.sig 不是 base64");
  const raw = Buffer.from(s, "base64");
  if (raw.length !== 64 || !crypto.verify(null, sums, key, raw)) throw new Error("SHA256SUMS 的签名无效（不是官方发布签名，或文件被改过）");
  const lines = Buffer.from(sums).toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("commit "));
  if (lines.length !== 1) throw new Error("SHA256SUMS 里没有唯一的 commit 行");
  const m = lines[0].match(/^commit ([0-9a-f]{40}) (\S+)$/);
  if (!m) throw new Error(`commit 行格式不对：${lines[0]}`);
  if (m[2] !== tag) throw new Error(`签名里的版本是 ${m[2]}，不是要检出的 ${tag}`);
  return m[1];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
async function download(fetcher: Fetch, url: string): Promise<Uint8Array> {
  const r = await fetcher(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!r.ok) throw new Error(`${url}：HTTP ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error(`${url}：文件过大`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > MAX_BYTES) throw new Error(`${url}：文件过大`);
  return b;
}

/** 依次尝试各个来源，返回第一份签名有效的发布记录对应的提交。 */
export async function fetchVerifiedCommit(tag: string, fetcher: Fetch = fetch, publicKey = RELEASE_PUBLIC_KEY, sources = releaseSources(tag)): Promise<string> {
  const errors: string[] = [];
  for (const base of sources) {
    try {
      const [sums, sig] = await Promise.all([download(fetcher, base + "SHA256SUMS"), download(fetcher, base + "SHA256SUMS.sig")]);
      return verifyRelease(sums, Buffer.from(sig).toString("utf8"), tag, publicKey);
    } catch (e) { errors.push((e as Error).message); }
  }
  throw new Error(`拿不到 ${tag} 的有效发布签名：${errors.join("；")}`);
}

const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 8 << 20 }, (e, out, err) => (e ? reject(new Error(`git ${args[0]}：${String(err || e.message).trim()}`)) : resolve(String(out).trim()))));

export interface SelfUpdateResult { tag: string; commit: string; previous: string; changed: boolean }

/** 把程序目录（灵魂桥所在的 Project.Quetzal 检出）切到最新的、签名核对过的正式版。 */
export async function selfUpdate(o: { root?: string; fetcher?: Fetch; publicKey?: string; sources?: (tag: string) => string[] } = {}): Promise<SelfUpdateResult> {
  const here = o.root ?? path.dirname(fileURLToPath(import.meta.url));
  const root = await git(here, ["rev-parse", "--show-toplevel"]);
  const shallow = (await git(root, ["rev-parse", "--is-shallow-repository"])) === "true";
  await git(root, ["fetch", "--quiet", "--force", "--tags", ...(shallow ? ["--depth=1"] : []), "origin"]);
  const tag = latestStable((await git(root, ["tag", "--list", "v*"])).split("\n"));
  if (!tag) throw new Error("仓库里没有正式版标签（vX.Y.Z）");
  const commit = await fetchVerifiedCommit(tag, o.fetcher ?? fetch, o.publicKey ?? RELEASE_PUBLIC_KEY, (o.sources ?? releaseSources)(tag));
  const local = await git(root, ["rev-parse", "--verify", `${tag}^{commit}`]);
  if (local !== commit) throw new Error(`本地标签 ${tag} 指向 ${local}，与发布签名里的 ${commit} 不一致：拒绝检出`);
  const previous = await git(root, ["rev-parse", "HEAD"]);
  if (previous !== commit) await git(root, ["checkout", "--quiet", "--detach", commit]);
  return { tag, commit, previous, changed: previous !== commit };
}

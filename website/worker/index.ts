// 官网的 Worker：只接管三类路径，其余交给静态资源（wrangler.jsonc 的 run_worker_first）。
//
//   /dl/<tag>/<资产>       GitHub Release 资产的镜像源。只代理本仓库、符合命名规则的资产；
//                          转发时用 GitHub 发布 JSON 里的 digest 核对 SHA-256，核对通过才缓存 7 天。
//                          小文件整体校验后发出；大文件边转发边算、扣住最后一块，不符就让流出错且不缓存。
//   /api/releases[/latest] GitHub 发布接口的镜像：改写下载地址、按 npm 版本封顶、边缘缓存 5 分钟，
//                          另存 7 天的陈旧副本供上游限流时顶上。
//   /install /install.ps1  构建时从 scripts/ 烘焙进来的安装脚本，以 text/plain 直出。
//
// 没有账号、令牌写在这里；GITHUB_TOKEN 是可选的 Worker Secret。
import { INSTALL_PS1, INSTALL_SH } from "./generated/installScripts";
import { Sha256 } from "./sha256";
import {
  GITHUB_RELEASES_API,
  NPM_LATEST_API,
  REPO,
  TAG_RE,
  assetsOf,
  capReleases,
  isAllowedAsset,
  isInstallableRelease,
  pickLatest,
  rewriteAssets,
  sortReleases,
  type Release,
} from "../shared/releases";

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GITHUB_TOKEN?: string;
  /** Workers 的 caches.default；测试注入内存实现。 */
  CACHE?: CacheLike;
  /** 测试注入的上游 fetch；生产用全局 fetch。 */
  FETCH?: typeof fetch;
  /** 测试可以覆盖烘焙的脚本，生产不设置。 */
  INSTALL_SH?: string;
  INSTALL_PS1?: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const API_TTL = 300;
const DL_TTL = 7 * 86400;
const STALE_TTL = 7 * 86400;
const RELEASE_TTL = 300;
const SMALL_MAX = 1 << 20;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com https://registry.npmjs.org",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function security(headers: Headers): Headers {
  headers.set("Content-Security-Policy", CSP);
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  return headers;
}

const cors = (headers: Headers): Headers => {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Content-Length, X-Digest, X-Npm-Version, X-Upstream");
  return headers;
};

const text = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: security(cors(new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }))),
  });

const fetchOf = (env: Env): typeof fetch => env.FETCH ?? fetch;
const cacheOf = (env: Env): CacheLike | undefined =>
  env.CACHE ?? (globalThis as unknown as { caches?: { default: CacheLike } }).caches?.default;

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function handle(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/install" || url.pathname === "/install.ps1") {
    if (method !== "GET" && method !== "HEAD") return text(405, "only GET");
    const body = url.pathname === "/install" ? (env.INSTALL_SH ?? INSTALL_SH) : (env.INSTALL_PS1 ?? INSTALL_PS1);
    const headers = security(cors(new Headers({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    })));
    return new Response(method === "HEAD" ? null : body, { status: 200, headers });
  }

  if (url.pathname.startsWith("/dl/") || url.pathname.startsWith("/api/")) {
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(new Headers({ "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Accept" })),
      });
    }
    if (method !== "GET" && method !== "HEAD") return text(405, "only GET");
    if (url.pathname === "/api/releases" || url.pathname === "/api/releases/latest") {
      return releases(url, request, env, ctx);
    }
    if (url.pathname.startsWith("/dl/")) return download(url, request, env, ctx);
    return text(404, "no such API");
  }

  const upstream = await env.ASSETS.fetch(request);
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: security(new Headers(upstream.headers)),
  });
}

type ReleaseAssetInfo = { name: string; digest?: string | null; size?: number };
type ReleaseLookup =
  | { status: "ok"; assets: ReleaseAssetInfo[] }
  | { status: "missing" }
  | { status: "unavailable" };

/** 按 tag 取发布 JSON 的资产清单（只留 name/digest/size），边缘缓存 5 分钟。 */
async function releaseByTag(origin: string, tag: string, env: Env, ctx: Ctx): Promise<ReleaseLookup> {
  const cache = cacheOf(env);
  const key = new Request(`${origin}/api/_release-tag/${tag}`, { method: "GET" });
  const hit = await cache?.match(key);
  const parse = (data: unknown): ReleaseLookup => {
    const assets = Array.isArray((data as { assets?: unknown })?.assets) ? (data as { assets: ReleaseAssetInfo[] }).assets : [];
    return {
      status: "ok",
      assets: assets.map((a) => ({ name: String(a.name ?? ""), digest: a.digest ?? null, size: a.size })),
    };
  };
  if (hit) return parse(await hit.json());

  const headers: Record<string, string> = {
    "User-Agent": "quetzalcoatl-site-mirror",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  let res: Response;
  try {
    res = await fetchOf(env)(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  } catch {
    return { status: "unavailable" };
  }
  if (res.status === 404) return { status: "missing" };
  if (!res.ok) return { status: "unavailable" };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { status: "unavailable" };
  }
  const out = parse(data);
  if (out.status === "ok" && cache) {
    ctx.waitUntil(
      cache
        .put(
          key,
          new Response(JSON.stringify({ assets: out.assets }), {
            headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${RELEASE_TTL}` },
          }),
        )
        .catch(() => undefined),
    );
  }
  return out;
}

/** 边转发边算 SHA-256；始终扣住最后一块，核对通过才放出，不符则让流出错。 */
function verifying(body: ReadableStream<Uint8Array>, expected: string, asset: string): ReadableStream<Uint8Array> {
  const hash = new Sha256();
  let pending: Uint8Array | undefined;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        if (pending) controller.enqueue(pending);
        pending = chunk;
      },
      flush(controller) {
        const got = hash.digestHex();
        if (got !== expected) throw new Error(`sha256 digest mismatch for ${asset}: got ${got}, signed ${expected}`);
        if (pending) controller.enqueue(pending);
      },
    }),
  );
}

async function download(url: URL, request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const [, , tag, asset, extra] = url.pathname.split("/");
  if (!tag || !asset || extra !== undefined || !TAG_RE.test(tag) || !isAllowedAsset(asset)) {
    return text(404, "only this project's named release assets are mirrored: /dl/<tag>/<file>");
  }
  const head = request.method === "HEAD";
  const cache = cacheOf(env);
  const key = new Request(`${url.origin}/dl/${tag}/${asset}`, { method: "GET" });
  const hit = await cache?.match(key);
  if (hit) return new Response(head ? null : hit.body, { status: hit.status, headers: security(cors(new Headers(hit.headers))) });

  const rel = await releaseByTag(url.origin, tag, env, ctx);
  if (rel.status === "missing") return text(404, `no such release: ${tag}`);
  // 拿不到发布元数据就无法核对 digest：宁可拒绝（fail-closed），不转发未经核对的字节。
  // 客户端与安装脚本都会在镜像失败时退回 GitHub 直连，签名校验仍是最后一道门。
  if (rel.status !== "ok") return text(502, `cannot verify ${asset}: release metadata unavailable`);

  const found = rel.assets.find((a) => a.name === asset);
  if (!found) return text(404, `release ${tag} has no ${asset}`);
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(found.digest ?? "").toLowerCase());
  const expected = match?.[1];
  if (!expected) return text(502, `GitHub did not publish a sha256 digest for ${asset}; refusing to forward`);
  let size: number | undefined;
  if (typeof found.size === "number" && found.size >= 0) size = found.size;

  const upstream = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  let res: Response;
  try {
    res = await fetchOf(env)(upstream, { redirect: "follow", headers: { "User-Agent": "quetzalcoatl-site-mirror" } });
  } catch (e) {
    return text(502, `cannot reach GitHub: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) return text(res.status === 404 ? 404 : 502, `GitHub returned ${res.status}`);

  const headers = security(cors(new Headers()));
  headers.set("Content-Type", res.headers.get("Content-Type") ?? "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${asset}"`);
  headers.set("X-Upstream", "github");
  const len = res.headers.get("Content-Length");

  headers.set("Cache-Control", `public, max-age=${DL_TTL}, immutable`);
  headers.set("X-Digest", `sha256:${expected}`);
  if (size === undefined && len && /^\d+$/.test(len)) size = Number(len);
  if (size !== undefined) headers.set("Content-Length", String(size));

  if (size !== undefined && size <= SMALL_MAX) {
    const buf = await res.arrayBuffer();
    if (hex(await crypto.subtle.digest("SHA-256", buf)) !== expected) {
      return text(502, `${asset}: sha256 does not match the digest GitHub published; not forwarding`);
    }
    if (cache && !head) {
      ctx.waitUntil(cache.put(key, new Response(buf, { status: 200, headers })).catch(() => undefined));
    }
    return new Response(head ? null : buf, { status: 200, headers });
  }

  const verified = verifying(res.body, expected, asset);
  if (head) return new Response(null, { status: 200, headers });
  const [client, toCache] = verified.tee();
  if (cache) ctx.waitUntil(cache.put(key, new Response(toCache, { status: 200, headers })).catch(() => undefined));
  return new Response(client, { status: 200, headers });
}

/** npm 上引导包的最新版本（边缘缓存 5 分钟 + 7 天陈旧副本）。读不到返回 undefined。 */
async function npmLatest(origin: string, env: Env, ctx: Ctx): Promise<string | undefined> {
  const cache = cacheOf(env);
  const key = new Request(`${origin}/api/_npm-latest`, { method: "GET" });
  const staleKey = new Request(`${origin}/api/_npm-latest?stale=1`, { method: "GET" });
  const hit = await cache?.match(key);
  if (hit) return (await hit.text()) || undefined;
  let version: string | undefined;
  try {
    const res = await fetchOf(env)(NPM_LATEST_API, {
      headers: { Accept: "application/json", "User-Agent": "quetzalcoatl-site-mirror" },
    });
    if (res.ok) {
      const json = (await res.json()) as { version?: unknown };
      if (typeof json.version === "string" && /^\d+\.\d+\.\d+/.test(json.version)) version = json.version;
    }
  } catch {
    /* 下面用陈旧副本 */
  }
  if (!version) {
    const stale = await cache?.match(staleKey);
    return stale ? (await stale.text()) || undefined : undefined;
  }
  if (cache) {
    ctx.waitUntil(
      Promise.all([
        cache.put(key, new Response(version, { headers: { "Cache-Control": `public, max-age=${API_TTL}` } })).catch(() => undefined),
        cache.put(staleKey, new Response(version, { headers: { "Cache-Control": `public, max-age=${STALE_TTL}` } })).catch(() => undefined),
      ]),
    );
  }
  return version;
}

const fresh = (res: Response): Response => {
  res.headers.set("Cache-Control", "no-cache");
  return res;
};

function withHeaders(res: Response, head: boolean): Response {
  return new Response(head ? null : res.body, { status: res.status, headers: security(cors(new Headers(res.headers))) });
}

/** /api/releases 与 /api/releases/latest：镜像 GitHub，改写地址，按 npm 版本封顶，边缘缓存 5 分钟。 */
async function releases(url: URL, request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const latestOnly = url.pathname.endsWith("/latest");
  const cache = cacheOf(env);
  const key = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const staleKey = new Request(`${url.origin}${url.pathname}?stale=1`, { method: "GET" });
  const head = request.method === "HEAD";
  const hit = await cache?.match(key);
  if (hit) return fresh(withHeaders(hit, head));

  const headers: Record<string, string> = {
    "User-Agent": "quetzalcoatl-site-mirror",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const stale = async (): Promise<Response | undefined> => {
    const copy = await cache?.match(staleKey);
    if (!copy) return undefined;
    const res = withHeaders(copy, head);
    res.headers.set("X-Upstream", "stale");
    return fresh(res);
  };

  let res: Response;
  try {
    res = await fetchOf(env)(`${GITHUB_RELEASES_API}?per_page=30`, { headers });
  } catch (e) {
    return (await stale()) ?? text(502, `cannot reach the GitHub API: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const cached = await stale();
    if (cached) return cached;
    return new Response(await res.text(), {
      status: res.status,
      headers: security(cors(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }))),
    });
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return (await stale()) ?? text(502, "GitHub returned invalid JSON");
  }
  const list = Array.isArray(data) ? (data as Release[]) : [];
  const npm = await npmLatest(url.origin, env, ctx);
  const capped = capReleases(list.map((release) => rewriteAssets(url.origin, release)), npm);
  // 只保留本产品品牌且带完整签名的发布：同仓库 V1 的 v1.11.0 没有 quetzalcoatl-* 资产，
  // 不能出现在 /api/releases，更不能被 /api/releases/latest 选中。预发布保留（带 badge），
  // 在尚无稳定版时 latest 回退到最新预发布版本。
  const qualified = sortReleases(capped.filter(isInstallableRelease));
  const body = latestOnly ? pickLatest(qualified) : qualified;
  if (latestOnly && !body) return text(404, "no signed release for this product yet");

  const outHeaders = security(
    cors(
      new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${API_TTL}`,
        "X-Upstream": "github",
        "X-Npm-Version": npm ?? "unknown",
      }),
    ),
  );
  const payload = JSON.stringify(body);
  const out = new Response(payload, { status: 200, headers: outHeaders });
  if (cache) {
    const staleHeaders = new Headers(outHeaders);
    staleHeaders.set("Cache-Control", `public, max-age=${STALE_TTL}`);
    ctx.waitUntil(
      Promise.all([
        cache.put(key, new Response(payload, { status: 200, headers: outHeaders })).catch(() => undefined),
        cache.put(staleKey, new Response(payload, { status: 200, headers: staleHeaders })).catch(() => undefined),
      ]),
    );
  }
  return fresh(withHeaders(out, head));
}

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(request, env, ctx);
  },
};

// 官网的 Worker：只接管两类路径，其余全部交给静态资源（wrangler.jsonc 的 run_worker_first 只把这两类路由到这里）。
//   /dl/<tag>/<资产名>         GitHub Release 资产的镜像源（APK、Linux 控制台包、校验值）：GitHub 在不少网络里连不上，官网走 Cloudflare 能到。
//                               只镜像本仓库、符合命名的资产，不转发其他地址；先与发布 JSON 里 GitHub 记下的 sha256（digest）核对，
//                               核对通过才在 Cloudflare 边缘缓存 7 天（按 tag 不可变）；不符或没有 digest 时不缓存（见 download）。
//   /dl/latest/android.apk     302 到最新正式发布的 APK（/dl/<tag>/<名字>）：下载页在脚本跑起来之前就有这个链接，
//                               旧手机的浏览器跑不动页面脚本时照样能下载。
//   /api/releases[/latest]      GitHub 发布接口的镜像（匿名 60 次 / 小时 / IP 是对 Cloudflare 出口算的，所以边缘缓存 5 分钟，浏览器不另存；
//                               设置 Secret GITHUB_TOKEN 可提高到 5000 次 / 小时）。返回的 JSON 把每个资产的 browser_download_url
//                               改写为上面的 /dl/ 地址，原地址放在 github_download_url，客户端先走官网、失败再退回 GitHub。
//                               另存一份 7 天的陈旧副本：上游限流或出错时用它顶上（X-Upstream: stale），页面与 App 不至于空白。
//   POST /api/oauth/github/token  GitHub OAuth 换令牌的中转（给本项目运营的同步服务用）：它所在的中国大陆机房连 github.com 时通时断，
//                               直连失败时经这里转发 github.com/login/oauth/access_token。只放行 Worker 变量 OAUTH_CLIENT_IDS（逗号分隔，
//                               在 Cloudflare 控制台设置，不入库）里的 client_id，没设置就不转发；只转发这一个地址，
//                               不缓存、不记录请求体（里面有 client_secret 与授权码），也不给浏览器开 CORS。
// 没有任何账号、令牌写在这里；GITHUB_TOKEN 是可选的 Worker Secret（wrangler secret put GITHUB_TOKEN）。
const REPO = "PlutoKeating/Project.Quetzal";
const TAG = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
// 资产：APK、Linux 控制台包、合并的 SHA256SUMS 与它的签名 SHA256SUMS.sig（旧版本还有按架构分开的 SHA256SUMS-linux-*）
const ASSET = /^(?:quetzal-[A-Za-z0-9.+-]+\.(?:apk|tar\.gz)|SHA256SUMS(?:\.sig|-[a-z0-9-]+)?)$/;
// RELEASE_TTL：按 tag 取的发布 JSON（只用来核对 /dl/ 资产的 digest）；SMALL_MAX：不超过它的资产整个读进来核对，不符直接 502
const API_TTL = 300, DL_TTL = 7 * 86400, STALE_TTL = 7 * 86400, RELEASE_TTL = 300, SMALL_MAX = 1 << 20;

interface Env { ASSETS: { fetch(req: Request): Promise<Response> }; GITHUB_TOKEN?: string; OAUTH_CLIENT_IDS?: string }
interface Ctx { waitUntil(p: Promise<unknown>): void }
const cacheOf = () => (caches as unknown as { default: Cache }).default;
const cors = (h: Headers) => { h.set("Access-Control-Allow-Origin", "*"); h.set("Access-Control-Expose-Headers", "x-ratelimit-remaining, x-ratelimit-reset, Content-Length"); return h; };
const text = (status: number, body: string) => new Response(body, { status, headers: cors(new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })) });

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/oauth/github/token") return oauthToken(request, env);
    if (url.pathname.startsWith("/dl/") || url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(new Headers({ "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Accept" })) });
      if (request.method !== "GET" && request.method !== "HEAD") return text(405, "只支持 GET");
      if (url.pathname === "/dl/latest/android.apk") return latestApk(url, env, ctx);
      if (url.pathname.startsWith("/dl/")) return download(url, request, env, ctx);
      if (url.pathname === "/api/releases" || url.pathname === "/api/releases/latest") return releases(url, request, env, ctx);
      return text(404, "没有这个接口");
    }
    return env.ASSETS.fetch(request);
  },
};

/** /dl/<tag>/<资产名> → github.com/<仓库>/releases/download/<tag>/<资产名>（跟随到 objects.githubusercontent.com 的跳转），核对后边缘缓存。
 *  核对：先按 tag 取发布 JSON（api.github.com/…/releases/tags/<tag>，缓存 5 分钟），找到这个资产与 GitHub 记下的 `digest`（"sha256:<hex>"）：
 *  - 资产不在这个发布里 → 404；有资产但没有可用的 digest → 502（不转发、不缓存）；
 *  - 不大于 SMALL_MAX 的文件（SHA256SUMS、.sig）整个读进来算哈希，不符 → 502；
 *  - 大文件边转发边算哈希，最后一块扣到核对通过才发出，不符就让流出错：客户端拿到的是截断的文件（Content-Length 对不上），边缘也不缓存；
 *  - 发布 JSON 取不到（限流、连不上）：照常转发但不缓存（Cache-Control: no-store，X-Digest: unavailable）。客户端自己还会核对签名。 */
async function download(url: URL, request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const [, , tag, asset, extra] = url.pathname.split("/");
  if (!tag || !asset || extra !== undefined || !TAG.test(tag) || !ASSET.test(asset)) return text(404, "只镜像本项目发布页的资产：/dl/<tag>/<文件名>");
  const head = request.method === "HEAD";
  const cache = cacheOf();
  const key = new Request(`${url.origin}/dl/${tag}/${asset}`, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, head);

  const rel = await releaseByTag(url, tag, env, ctx);
  if (rel.status === "missing") return text(404, `没有这个发布：${tag}`);
  let expected: string | undefined, size: number | undefined;
  if (rel.status === "ok") {
    const a = rel.assets.find((x) => x.name === asset);
    if (!a) return text(404, `发布 ${tag} 里没有 ${asset}`);
    const m = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? "").toLowerCase());
    if (!m) return text(502, `GitHub 没有给出 ${asset} 的 sha256，不转发`);
    expected = m[1];
    if (typeof a.size === "number" && a.size >= 0) size = a.size;
  }

  const upstream = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  let res: Response;
  try { res = await fetch(upstream, { redirect: "follow", headers: { "User-Agent": "quetzal-site-mirror" } }); }
  catch (e) { return text(502, `连不上 GitHub：${(e as Error).message}`); }
  if (!res.ok || !res.body) return text(res.status === 404 ? 404 : 502, `GitHub 返回 ${res.status}`);
  const headers = cors(new Headers());
  headers.set("Content-Type", res.headers.get("Content-Type") ?? "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${asset}"`);
  headers.set("X-Upstream", "github");
  const len = res.headers.get("Content-Length");

  if (!expected) {
    // 没法核对：只转发，不进边缘缓存，也不让浏览器长期缓存
    if (len) headers.set("Content-Length", len);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Digest", "unavailable");
    return new Response(head ? null : res.body, { status: 200, headers });
  }
  headers.set("Cache-Control", `public, max-age=${DL_TTL}, immutable`);
  headers.set("X-Digest", `sha256:${expected}`);
  if (size === undefined && len && /^\d+$/.test(len)) size = Number(len);

  if (size !== undefined && size <= SMALL_MAX) {
    const buf = await res.arrayBuffer();
    if (hex(await crypto.subtle.digest("SHA-256", buf)) !== expected) return text(502, `${asset} 的 sha256 与 GitHub 记录的不符，不转发`);
    headers.set("Content-Length", String(buf.byteLength));
    ctx.waitUntil(cache.put(key, new Response(buf, { status: 200, headers })));
    return new Response(head ? null : buf, { status: 200, headers });
  }

  // 已知大小时套一层 FixedLengthStream：响应带 Content-Length（客户端的进度条要用），字节数不对也会出错
  let verified = verifying(res.body, expected);
  if (size !== undefined) {
    const fixed = new (globalThis as unknown as { FixedLengthStream: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream(size);
    verified = verified.pipeThrough(fixed);
  }
  if (head) {
    ctx.waitUntil(cache.put(key, new Response(verified, { status: 200, headers })).catch(() => undefined));
    return new Response(null, { status: 200, headers });
  }
  const [client, toCache] = verified.tee();
  // 核对失败时 toCache 流出错，cache.put 随之失败，什么也不存
  ctx.waitUntil(cache.put(key, new Response(toCache, { status: 200, headers })).catch(() => undefined));
  return new Response(client, { status: 200, headers });
}

type Digester = WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
/** 边转发边算 sha256（Workers 的 crypto.DigestStream）；始终扣住最后一块，核对通过才放出，不符则让流出错。 */
function verifying(body: ReadableStream<Uint8Array>, expected: string): ReadableStream<Uint8Array> {
  const ds = new (crypto as unknown as { DigestStream: new (alg: string) => Digester }).DigestStream("SHA-256");
  const w = ds.getWriter();
  let pending: Uint8Array | undefined;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, c) {
      await w.write(chunk);
      if (pending) c.enqueue(pending);
      pending = chunk;
    },
    async flush(c) {
      await w.close();
      if (hex(await ds.digest) !== expected) throw new Error("sha256 与 GitHub 记录的不符");
      if (pending) c.enqueue(pending);
    },
  }));
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

type ReleaseAsset = { name: string; digest?: string | null; size?: number };
type ReleaseLookup = { status: "ok"; assets: ReleaseAsset[] } | { status: "missing" } | { status: "unavailable" };
/** 按 tag 取发布 JSON 里的资产清单（name、digest、size），边缘缓存 RELEASE_TTL；404 记作 missing，其他失败记作 unavailable（不缓存）。 */
async function releaseByTag(url: URL, tag: string, env: Env, ctx: Ctx): Promise<ReleaseLookup> {
  const cache = cacheOf();
  const key = new Request(`${url.origin}/api/_release-tag/${tag}`, { method: "GET" });
  const hit = await cache.match(key);
  const parse = (data: unknown): ReleaseLookup => {
    const assets = Array.isArray((data as { assets?: unknown }).assets) ? (data as { assets: ReleaseAsset[] }).assets : [];
    return { status: "ok", assets: assets.map((a) => ({ name: String(a.name ?? ""), digest: a.digest ?? null, size: a.size })) };
  };
  if (hit) return parse(await hit.json());
  const h: Record<string, string> = { "User-Agent": "quetzal-site-mirror", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  let res: Response;
  try { res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: h }); }
  catch { return { status: "unavailable" }; }
  if (res.status === 404) return { status: "missing" };
  if (!res.ok) return { status: "unavailable" };
  let data: unknown;
  try { data = await res.json(); } catch { return { status: "unavailable" }; }
  const out = parse(data);
  if (out.status === "ok") {
    const body = JSON.stringify({ assets: out.assets });
    ctx.waitUntil(cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${RELEASE_TTL}` } })));
  }
  return out;
}

/** /dl/latest/android.apk：经 /api/releases/latest（同一份边缘缓存与陈旧副本）找到最新正式发布的 APK，302 过去。 */
async function latestApk(url: URL, env: Env, ctx: Ctx): Promise<Response> {
  const res = await releases(new URL("/api/releases/latest", url.origin), new Request(url.origin, { method: "GET" }), env, ctx);
  if (!res.ok) return text(502, "暂时读不到最新发布，请稍后再试");
  const r = await res.json() as { tag_name?: string; assets?: { name?: string }[] };
  const tag = String(r.tag_name ?? "");
  const apk = (r.assets ?? []).map((a) => String(a.name ?? "")).find((n) => n.endsWith(".apk") && ASSET.test(n));
  if (!TAG.test(tag) || !apk) return text(404, "最新发布里没有 APK");
  return new Response(null, { status: 302, headers: cors(new Headers({ Location: `${url.origin}/dl/${tag}/${apk}`, "Cache-Control": "public, max-age=60" })) });
}

/** /api/releases 与 /api/releases/latest：镜像 api.github.com，改写资产地址，边缘缓存 5 分钟。 */
async function releases(url: URL, request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const latest = url.pathname.endsWith("/latest");
  const cache = cacheOf();
  const key = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const staleKey = new Request(`${url.origin}${url.pathname}?stale=1`, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return fresh(withHeaders(hit, request.method === "HEAD"));
  const upstream = `https://api.github.com/repos/${REPO}/releases${latest ? "/latest" : "?per_page=30"}`;
  const h: Record<string, string> = { "User-Agent": "quetzal-site-mirror", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  // 上游失败（连不上、限流、5xx）：有陈旧副本就用它，没有才把错误原样给出去（客户端据此退回直连 GitHub）
  const stale = async () => { const s = await cache.match(staleKey); if (!s) return undefined; const r = withHeaders(s, request.method === "HEAD"); r.headers.set("X-Upstream", "stale"); return fresh(r); };
  let res: Response;
  try { res = await fetch(upstream, { headers: h }); }
  catch (e) { return (await stale()) ?? text(502, `连不上 GitHub 接口：${(e as Error).message}`); }
  if (!res.ok) {
    const s = await stale(); if (s) return s;
    const headers = cors(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }));
    for (const k of ["x-ratelimit-remaining", "x-ratelimit-reset"]) { const v = res.headers.get(k); if (v) headers.set(k, v); }
    return new Response(await res.text(), { status: res.status, headers });
  }
  const data = await res.json() as unknown;
  const rewrite = (r: Record<string, unknown>) => {
    const tag = String(r.tag_name ?? "");
    const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
    for (const a of assets) {
      const name = String(a.name ?? "");
      if (TAG.test(tag) && ASSET.test(name)) { a.github_download_url = a.browser_download_url; a.browser_download_url = `${url.origin}/dl/${tag}/${name}`; }
    }
    return r;
  };
  const body = JSON.stringify(Array.isArray(data) ? data.map((r) => rewrite(r as Record<string, unknown>)) : rewrite(data as Record<string, unknown>));
  const headers = cors(new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${API_TTL}`, "X-Upstream": "github" }));
  const out = new Response(body, { status: 200, headers });
  const staleCopy = new Response(body, { status: 200, headers: new Headers({ ...Object.fromEntries(headers), "Cache-Control": `public, max-age=${STALE_TTL}` }) });
  ctx.waitUntil(Promise.all([cache.put(key, out.clone()), cache.put(staleKey, staleCopy)]));
  return fresh(withHeaders(out, request.method === "HEAD"));
}

/** 发布接口给浏览器的响应不让浏览器另存（边缘那份 5 分钟的缓存照旧）：访客一刷新就拿到边缘上最新的一份。 */
function fresh(res: Response): Response { res.headers.set("Cache-Control", "no-cache"); return res; }

function withHeaders(res: Response, head: boolean): Response {
  const headers = cors(new Headers(res.headers));
  return new Response(head ? null : res.body, { status: res.status, headers });
}

/** GitHub OAuth 换令牌的中转：同步服务 POST application/x-www-form-urlencoded（client_id、client_secret、code、redirect_uri），原样转给 GitHub。 */
async function oauthToken(request: Request, env: Env): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded")) return json(415, { error: "form_required" });
  const body = await request.text();
  if (body.length > 4096) return json(413, { error: "too_large" });
  const form = new URLSearchParams(body);
  const allowed = new Set((env.OAUTH_CLIENT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  if (!allowed.size) return json(503, { error: "relay_not_configured" });
  if (!allowed.has(form.get("client_id") ?? "")) return json(403, { error: "client_not_allowed" });
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "quetzal-sync-relay" },
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return json(502, { error: "upstream_unreachable" });
  }
}

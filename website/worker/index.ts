// 官网的 Worker：只接管两类路径，其余全部交给静态资源（wrangler.jsonc 的 run_worker_first 只把这两类路由到这里）。
//   /dl/<tag>/<资产名>         代理 GitHub Release 的资产下载（APK、Linux 控制台包、校验值）：GitHub 在不少网络里连不上，官网走 Cloudflare 能到。
//                               只放行本仓库、符合命名的资产，不是开放代理；按 tag 不可变，Cloudflare 边缘缓存 7 天。
//   /api/releases[/latest]      代理 GitHub 的发布接口（匿名 60 次 / 小时 / IP 是对 Cloudflare 出口算的，所以边缘缓存 5 分钟；
//                               设置 Secret GITHUB_TOKEN 可提高到 5000 次 / 小时）。返回的 JSON 把每个资产的 browser_download_url
//                               改写为上面的 /dl/ 地址，原地址放在 github_download_url，客户端先走官网、失败再退回 GitHub。
// 没有任何账号、令牌写在这里；GITHUB_TOKEN 是可选的 Worker Secret（wrangler secret put GITHUB_TOKEN）。
const REPO = "PlutoKeating/Project.Quetzal";
const TAG = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const ASSET = /^(?:quetzal-[A-Za-z0-9.+-]+\.(?:apk|tar\.gz)|SHA256SUMS(?:-[a-z0-9-]+)?)$/;
const API_TTL = 300, DL_TTL = 7 * 86400;

interface Env { ASSETS: { fetch(req: Request): Promise<Response> }; GITHUB_TOKEN?: string }
interface Ctx { waitUntil(p: Promise<unknown>): void }
const cacheOf = () => (caches as unknown as { default: Cache }).default;
const cors = (h: Headers) => { h.set("Access-Control-Allow-Origin", "*"); h.set("Access-Control-Expose-Headers", "x-ratelimit-remaining, x-ratelimit-reset, Content-Length"); return h; };
const text = (status: number, body: string) => new Response(body, { status, headers: cors(new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })) });

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/dl/") || url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(new Headers({ "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Accept" })) });
      if (request.method !== "GET" && request.method !== "HEAD") return text(405, "只支持 GET");
      if (url.pathname.startsWith("/dl/")) return download(url, request, ctx);
      if (url.pathname === "/api/releases" || url.pathname === "/api/releases/latest") return releases(url, request, env, ctx);
      return text(404, "没有这个接口");
    }
    return env.ASSETS.fetch(request);
  },
};

/** /dl/<tag>/<资产名> → github.com/<仓库>/releases/download/<tag>/<资产名>（跟随到 objects.githubusercontent.com 的跳转），边缘缓存。 */
async function download(url: URL, request: Request, ctx: Ctx): Promise<Response> {
  const [, , tag, asset, extra] = url.pathname.split("/");
  if (!tag || !asset || extra !== undefined || !TAG.test(tag) || !ASSET.test(asset)) return text(404, "只代理本项目发布页的资产：/dl/<tag>/<文件名>");
  const cache = cacheOf();
  const key = new Request(`${url.origin}/dl/${tag}/${asset}`, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, request.method === "HEAD");
  const upstream = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  let res: Response;
  try { res = await fetch(upstream, { redirect: "follow", headers: { "User-Agent": "quetzal-site-proxy" } }); }
  catch (e) { return text(502, `连不上 GitHub：${(e as Error).message}`); }
  if (!res.ok) return text(res.status === 404 ? 404 : 502, `GitHub 返回 ${res.status}`);
  const headers = cors(new Headers());
  headers.set("Content-Type", res.headers.get("Content-Type") ?? "application/octet-stream");
  const len = res.headers.get("Content-Length"); if (len) headers.set("Content-Length", len);
  headers.set("Content-Disposition", `attachment; filename="${asset}"`);
  headers.set("Cache-Control", `public, max-age=${DL_TTL}, immutable`);
  headers.set("X-Upstream", "github");
  const out = new Response(res.body, { status: 200, headers });
  ctx.waitUntil(cache.put(key, out.clone()));
  return withHeaders(out, request.method === "HEAD");
}

/** /api/releases 与 /api/releases/latest：代理 api.github.com，改写资产地址，边缘缓存 5 分钟。 */
async function releases(url: URL, request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const latest = url.pathname.endsWith("/latest");
  const cache = cacheOf();
  const key = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, request.method === "HEAD");
  const upstream = `https://api.github.com/repos/${REPO}/releases${latest ? "/latest" : "?per_page=30"}`;
  const h: Record<string, string> = { "User-Agent": "quetzal-site-proxy", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  let res: Response;
  try { res = await fetch(upstream, { headers: h }); }
  catch (e) { return text(502, `连不上 GitHub 接口：${(e as Error).message}`); }
  if (!res.ok) {
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
  ctx.waitUntil(cache.put(key, out.clone()));
  return withHeaders(out, request.method === "HEAD");
}

function withHeaders(res: Response, head: boolean): Response {
  const headers = cors(new Headers(res.headers));
  return new Response(head ? null : res.body, { status: res.status, headers });
}

// Worker 单元测试（vitest，node 环境）：发布镜像、版本封顶、资产白名单、流式 SHA-256 校验与安全响应头。
// 这里断言的都是「可证伪」的行为：错一字节必须让流出错且不进缓存；未签名/未允许的资产必须 404。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handle, type CacheLike, type Env } from "./index";

const REPO = "PlutoKeating/Project.Quetzal";
const ORIGIN = "https://quetzal.example";

const hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 行为接近 Workers Cache API 的内存实现：记录 put 次数与内容。 */
class MemoryCache implements CacheLike {
  readonly entries = new Map<string, Response>();
  puts = 0;
  /** 只统计 /dl/ 资产缓存：发布 JSON 与 npm 版本的探测也会写缓存，不能混在一起断言。 */
  dlPuts = 0;
  async match(request: Request): Promise<Response | undefined> {
    const hit = this.entries.get(request.url);
    return hit ? hit.clone() : undefined;
  }
  async put(request: Request, response: Response): Promise<void> {
    const body = await response.arrayBuffer();
    this.puts += 1;
    if (request.url.includes("/dl/")) this.dlPuts += 1;
    this.entries.set(request.url, new Response(body, { status: response.status, headers: response.headers }));
  }
}

type Route = (url: string) => Response | Promise<Response> | undefined;

const textResponse = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });

const releaseFixture = (
  tag: string,
  assets: { name: string; bytes?: Uint8Array; digest?: string | null; size?: number }[],
  prerelease = false,
) => ({
  tag_name: tag,
  name: `Quetzalcoatl ${tag}`,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  published_at: "2026-11-01T00:00:00Z",
  draft: false,
  prerelease,
  assets: assets.map((a) => ({
    name: a.name,
    size: a.size ?? a.bytes?.byteLength ?? 0,
    digest: a.digest === null ? null : (a.digest ?? `sha256:${hex(a.bytes ?? new Uint8Array())}`),
    browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${a.name}`,
  })),
});

const makeEnv = (route: Route, over: Partial<Env> = {}): Env & { cache: MemoryCache } => {
  const cache = new MemoryCache();
  const env: Env & { cache: MemoryCache } = {
    ASSETS: {
      fetch: async () => new Response("<!doctype html><title>static</title>", { headers: { "Content-Type": "text/html" } }),
    },
    CACHE: cache,
    FETCH: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const hit = await route(url);
      if (!hit) throw new Error(`unexpected upstream request: ${url}`);
      return hit;
    },
    cache,
    ...over,
  };
  return env;
};

const run = (path: string, env: Env, method = "GET"): Promise<Response> =>
  handle(new Request(`${ORIGIN}${path}`, { method }), env, { waitUntil: (p: Promise<unknown>) => void p });

const json = async (res: Response): Promise<unknown> => JSON.parse(await res.text());

describe("worker: signed asset mirror", () => {
  it("streams a small asset whose sha256 matches the release digest and caches it", async () => {
    const bytes = new TextEncoder().encode("signed-artifact");
    const rel = releaseFixture("v1.0.0", [{ name: "SHA256SUMS", bytes }]);
    const env = makeEnv((url) => {
      if (url.includes("/releases/tags/v1.0.0")) return textResponse(JSON.stringify(rel));
      if (url.includes("SHA256SUMS")) return new Response(bytes);
      return undefined;
    });
    const res = await run("/dl/v1.0.0/SHA256SUMS", env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("signed-artifact");
    expect(res.headers.get("Cache-Control")).toContain("max-age=604800");
    expect(env.cache.dlPuts).toBe(1);
  });

  it("aborts a small asset whose digest does not match (canary is never delivered)", async () => {
    const signed = new TextEncoder().encode("signed-artifact");
    const canary = new TextEncoder().encode("TAMPERED-CANARY");
    const rel = releaseFixture("v1.0.0", [{ name: "SHA256SUMS", bytes: signed }]);
    const env = makeEnv((url) => {
      if (url.includes("/releases/tags/v1.0.0")) return textResponse(JSON.stringify(rel));
      if (url.includes("SHA256SUMS")) return new Response(canary);
      return undefined;
    });
    const res = await run("/dl/v1.0.0/SHA256SUMS", env);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain("TAMPERED-CANARY");
    expect(env.cache.dlPuts).toBe(0);
  });

  it("aborts a large streamed asset on a digest mismatch and never caches it", async () => {
    const size = 2 * 1024 * 1024; // > 1 MiB：走边转发边算哈希的路径
    const signed = new Uint8Array(size);
    for (let i = 0; i < size; i++) signed[i] = i % 251;
    const tampered = signed.slice();
    tampered[Math.floor(size / 2)] = (tampered[Math.floor(size / 2)] ?? 0) ^ 0xff; // 单字节翻转
    const rel = releaseFixture("v1.0.0", [{ name: "quetzalcoatl-1.0.0-linux-x64.tar.gz", bytes: signed }]);
    const env = makeEnv((url) => {
      if (url.includes("/releases/tags/v1.0.0")) return textResponse(JSON.stringify(rel));
      if (url.includes(".tar.gz")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < tampered.byteLength; offset += 64 * 1024) {
              controller.enqueue(tampered.slice(offset, offset + 64 * 1024));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Length": String(tampered.byteLength) } });
      }
      return undefined;
    });
    const res = await run("/dl/v1.0.0/quetzalcoatl-1.0.0-linux-x64.tar.gz", env);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow(/sha256|digest/i);
    // 核对失败：缓存里绝不允许出现这份字节
    expect(env.cache.dlPuts).toBe(0);
  });

  it("refuses to forward an asset whose release has no GitHub digest", async () => {
    const rel = releaseFixture("v1.0.0", [{ name: "SHA256SUMS", bytes: new Uint8Array([1]), digest: null }]);
    const env = makeEnv((url) => (url.includes("/releases/tags/v1.0.0") ? textResponse(JSON.stringify(rel)) : new Response("x")));
    const res = await run("/dl/v1.0.0/SHA256SUMS", env);
    expect(res.status).toBe(502);
    expect(env.cache.dlPuts).toBe(0);
  });

  it("refuses to forward when release metadata is unavailable (fail-closed)", async () => {
    const env = makeEnv((url) => (url.includes("/releases/tags/v1.0.0") ? new Response("upstream error", { status: 500 }) : new Response("x")));
    const res = await run("/dl/v1.0.0/SHA256SUMS", env);
    expect(res.status).toBe(502);
    expect(env.cache.dlPuts).toBe(0);
  });

  it("rejects assets outside the allowlist and malformed tags", async () => {
    const env = makeEnv(() => textResponse("{}"));
    for (const path of [
      "/dl/v1.0.0/evil.sh",
      "/dl/v1.0.0/../etc/passwd",
      "/dl/v1.0.0/quetzalcoatl-1.0.0-linux-x64.tar.gz.sha256",
      "/dl/not-a-tag/quetzalcoatl-1.0.0-linux-x64.tar.gz",
      "/dl/v1.0.0/quetzalcoatl-1.0.0-freebsd-x64.tar.gz",
    ]) {
      const res = await run(path, env);
      expect(res.status, path).toBe(404);
    }
  });

  it("rejects an asset that exists on GitHub but is not in this release", async () => {
    const rel = releaseFixture("v1.0.0", [{ name: "SHA256SUMS", bytes: new TextEncoder().encode("x") }]);
    const env = makeEnv((url) => (url.includes("/releases/tags/v1.0.0") ? textResponse(JSON.stringify(rel)) : new Response("x")));
    const res = await run("/dl/v1.0.0/quetzalcoatl-1.0.0-macos-arm64.tar.gz", env);
    expect(res.status).toBe(404);
  });
});

describe("worker: release API", () => {
  const signedAssets = (version: string) => [
    { name: `quetzalcoatl-${version}-linux-x64.tar.gz`, bytes: new TextEncoder().encode("bin") },
    { name: "SHA256SUMS", bytes: new TextEncoder().encode("sums") },
    { name: "SHA256SUMS.sig", bytes: new TextEncoder().encode("sig") },
  ];
  const list = [releaseFixture("v1.2.0", signedAssets("1.2.0")), releaseFixture("v1.1.0", signedAssets("1.1.0"))];

  const apiRoute = (npm: string | undefined): Route => (url) => {
    if (url.includes("api.github.com") && url.includes("/releases?")) return textResponse(JSON.stringify(list));
    if (url.includes("registry.npmjs.org")) return npm ? textResponse(JSON.stringify({ version: npm })) : new Response("nope", { status: 404 });
    return undefined;
  };

  it("caps releases at the npm-published binary version", async () => {
    const env = makeEnv(apiRoute("1.1.0"));
    const res = await run("/api/releases", env);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { tag_name: string }[];
    expect(body.map((r) => r.tag_name)).toEqual(["v1.1.0"]);
    expect(res.headers.get("X-Npm-Version")).toBe("1.1.0");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("latest never advertises a version newer than npm", async () => {
    const env = makeEnv(apiRoute("1.1.0"));
    const res = await run("/api/releases/latest", env);
    const body = (await json(res)) as { tag_name: string };
    expect(body.tag_name).toBe("v1.1.0");
  });

  it("never picks an unsigned release as latest", async () => {
    const unsigned = releaseFixture("v1.3.0", [{ name: "quetzalcoatl-1.3.0-linux-x64.tar.gz", bytes: new TextEncoder().encode("bin") }]);
    const env = makeEnv((url) => {
      if (url.includes("/releases?")) return textResponse(JSON.stringify([unsigned, ...list]));
      if (url.includes("registry.npmjs.org")) return textResponse(JSON.stringify({ version: "1.3.0" }));
      return undefined;
    });
    const res = await run("/api/releases/latest", env);
    const body = (await json(res)) as { tag_name: string };
    expect(body.tag_name).toBe("v1.2.0"); // 1.3.0 没有 SHA256SUMS + .sig
  });

  it("excludes legacy V1 releases that have no quetzalcoatl-* assets", async () => {
    const legacy = releaseFixture("v1.11.0", [
      { name: "quetzal-1.11.0-linux-x64.tar.gz", bytes: new TextEncoder().encode("v1") },
      { name: "SHA256SUMS", bytes: new TextEncoder().encode("sums") },
      { name: "SHA256SUMS.sig", bytes: new TextEncoder().encode("sig") },
    ]);
    const env = makeEnv((url) => {
      if (url.includes("/releases?")) return textResponse(JSON.stringify([legacy, ...list]));
      if (url.includes("registry.npmjs.org")) return new Response("nope", { status: 404 });
      return undefined;
    });
    const res = await run("/api/releases", env);
    const body = (await json(res)) as { tag_name: string }[];
    expect(body.map((r) => r.tag_name)).toEqual(["v1.2.0", "v1.1.0"]);
  });

  it("serves a qualifying prerelease as latest with prerelease: true", async () => {
    const alpha = releaseFixture("v2.0.0-alpha.1", signedAssets("2.0.0-alpha.1"), true);
    const legacy = releaseFixture("v1.11.0", [
      { name: "quetzal-1.11.0-linux-x64.tar.gz", bytes: new TextEncoder().encode("v1") },
      { name: "SHA256SUMS", bytes: new TextEncoder().encode("sums") },
      { name: "SHA256SUMS.sig", bytes: new TextEncoder().encode("sig") },
    ]);
    const env = makeEnv((url) => {
      if (url.includes("/releases?")) return textResponse(JSON.stringify([legacy, alpha]));
      if (url.includes("registry.npmjs.org")) return new Response("nope", { status: 404 });
      return undefined;
    });
    const res = await run("/api/releases/latest", env);
    const body = (await json(res)) as { tag_name: string; prerelease: boolean };
    expect(body.tag_name).toBe("v2.0.0-alpha.1");
    expect(body.prerelease).toBe(true);
  });

  it("keeps the newest stable release ahead of a newer prerelease", async () => {
    const beta = releaseFixture("v2.0.0-beta.1", signedAssets("2.0.0-beta.1"), true);
    const env = makeEnv((url) => {
      if (url.includes("/releases?")) return textResponse(JSON.stringify([beta, ...list]));
      if (url.includes("registry.npmjs.org")) return new Response("nope", { status: 404 });
      return undefined;
    });
    const res = await run("/api/releases/latest", env);
    const body = (await json(res)) as { tag_name: string };
    expect(body.tag_name).toBe("v1.2.0");
  });

  it("does not cap anything when the npm registry is unreachable", async () => {
    const env = makeEnv(apiRoute(undefined));
    const res = await run("/api/releases", env);
    const body = (await json(res)) as { tag_name: string }[];
    expect(body.map((r) => r.tag_name)).toEqual(["v1.2.0", "v1.1.0"]);
  });

  it("rewrites download URLs to the same-origin /dl mirror and keeps the GitHub URL", async () => {
    const env = makeEnv(apiRoute("1.2.0"));
    const res = await run("/api/releases", env);
    const body = (await json(res)) as { tag_name: string; assets: { name: string; browser_download_url: string; github_download_url: string }[] }[];
    const first = body[0];
    expect(first?.tag_name).toBe("v1.2.0");
    const sums = first?.assets.find((a) => a.name === "SHA256SUMS");
    expect(sums?.browser_download_url).toBe(`${ORIGIN}/dl/v1.2.0/SHA256SUMS`);
    expect(sums?.github_download_url).toContain("github.com");
  });

  it("caches the mirrored list for five minutes at the edge", async () => {
    const env = makeEnv(apiRoute("1.2.0"));
    await run("/api/releases", env);
    expect(env.cache.puts).toBeGreaterThanOrEqual(1);
  });
});

describe("worker: install scripts and headers", () => {
  it("serves the baked scripts/install.sh at /install as text/plain", async () => {
    const expected = readFileSync(fileURLToPath(new URL("../../scripts/install.sh", import.meta.url)), "utf8");
    const env = makeEnv(() => undefined);
    const res = await run("/install", env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toBe(expected);
    expect(body).toContain("RELEASE_PUBKEY=");
  });

  it("serves the baked install.ps1 at /install.ps1", async () => {
    const expected = readFileSync(fileURLToPath(new URL("../../scripts/install.ps1", import.meta.url)), "utf8");
    const env = makeEnv(() => undefined);
    const res = await run("/install.ps1", env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expected);
  });

  it("sets CSP, HSTS, nosniff, Referrer-Policy and Permissions-Policy on every route it owns", async () => {
    const env = makeEnv((url) => {
      if (url.includes("/releases?")) return textResponse("[]");
      if (url.includes("registry.npmjs.org")) return textResponse(JSON.stringify({ version: "1.0.0" }));
      return undefined;
    });
    for (const path of ["/install", "/install.ps1", "/api/releases", "/docs", "/"]) {
      const res = await run(path, env);
      expect(res.headers.get("Content-Security-Policy"), path).toContain("default-src 'self'");
      expect(res.headers.get("Strict-Transport-Security"), path).toContain("max-age=31536000");
      expect(res.headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy"), path).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("Permissions-Policy"), path).toContain("geolocation=()");
    }
  });

  it("never references a third-party script, font or CDN in its CSP", async () => {
    const env = makeEnv(() => undefined);
    const res = await run("/", env);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toMatch(/fonts\.googleapis|cdn\.|unpkg|jsdelivr|cloudflareinsights/);
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).toMatch(/font-src 'self'/);
  });
});

describe("worker: incremental sha256", () => {
  it("matches the known vectors, including a single-byte-at-a-time stream", async () => {
    const { sha256Hex, Sha256 } = await import("./sha256");
    expect(sha256Hex(new TextEncoder().encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    const one = new Sha256();
    for (const byte of bytes) one.update(new Uint8Array([byte]));
    expect(one.digestHex()).toBe("d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
  });

  it("agrees with node:crypto on a multi-chunk 3 MiB buffer", async () => {
    const { Sha256 } = await import("./sha256");
    const size = 3 * 1024 * 1024 + 17;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
    const hash = new Sha256();
    for (let offset = 0; offset < size; offset += 100003) hash.update(bytes.subarray(offset, offset + 100003));
    expect(hash.digestHex()).toBe(hex(bytes));
  });
});

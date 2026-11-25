import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  GITHUB_RELEASES_API,
  assetsOf,
  findPlatformAsset,
  isAllowedAsset,
  isInstallableRelease,
  isPrerelease,
  pickLatest,
  type PlatformId,
  type Release,
} from "@shared/releases";
import { useChrome, useLang, localized } from "~/i18n/core";
import { messages } from "./i18n";

export function meta({ location }: { location: { pathname: string } }) {
  const lang = location.pathname === "/en" || location.pathname.startsWith("/en/") ? "en" : "zh";
  const m = messages[lang];
  return [
    { title: `${m.metaTitle} · Quetzalcoatl` },
    { name: "description", content: m.metaDescription },
    { property: "og:title", content: m.metaTitle },
    { property: "og:description", content: m.metaDescription },
  ];
}

const PLATFORM_ORDER: PlatformId[] = ["linux-x64", "linux-arm64", "macos-arm64", "macos-x64", "windows-x64", "windows-arm64"];

function detectPlatform(): PlatformId {
  if (typeof navigator === "undefined") return "linux-x64";
  const ua = navigator.userAgent;
  const hash = typeof location !== "undefined" ? location.hash.slice(1) : "";
  if (PLATFORM_ORDER.includes(hash as PlatformId)) return hash as PlatformId;
  if (/Windows/i.test(ua)) return /ARM64|arm64/i.test(ua) ? "windows-arm64" : "windows-x64";
  if (/Macintosh|Mac OS X/i.test(ua)) return /arm64|aarch64/i.test(ua) ? "macos-arm64" : "macos-x64";
  if (/Linux/i.test(ua)) return /aarch64|arm64/i.test(ua) ? "linux-arm64" : "linux-x64";
  return "linux-x64";
}

function formatBytes(size: unknown): string {
  const n = typeof size === "number" ? size : Number(size);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

type State = { status: "loading" } | { status: "error" } | { status: "ready"; releases: Release[] };

/** 先走同源 Worker 的镜像（带版本封顶），失败再直连 GitHub API。 */
async function loadReleases(): Promise<Release[]> {
  try {
    const res = await fetch("/api/releases", { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data: unknown = await res.json();
      if (Array.isArray(data)) return data as Release[];
    }
  } catch {
    /* 下面退回 GitHub */
  }
  const res = await fetch(`${GITHUB_RELEASES_API}?per_page=30`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as Release[]) : [];
}

export default function Download() {
  const lang = useLang();
  const { t } = useChrome();
  const m = messages[lang];
  const [state, setState] = useState<State>({ status: "loading" });
  const [platform, setPlatform] = useState<PlatformId>("linux-x64");
  const link = (path: string) => localized(lang, path);

  const load = useCallback(() => {
    setState({ status: "loading" });
    loadReleases()
      .then((releases) => setState({ status: "ready", releases }))
      .catch(() => setState({ status: "error" }));
  }, []);

  useEffect(() => load(), [load]);
  useEffect(() => setPlatform(detectPlatform()), []);

  const installable = state.status === "ready" ? state.releases.filter(isInstallableRelease) : [];
  const latest = pickLatest(installable) ?? installable[0];
  const prerelease = latest ? isPrerelease(latest) : false;
  const version = latest ? String(latest.tag_name ?? "").replace(/^v/, "") : "";
  const asset = latest ? findPlatformAsset(latest, platform) : undefined;
  const assetUrl = asset ? String(asset.browser_download_url ?? "") : "";
  const isWindows = platform.startsWith("windows");
  const installCommand = isWindows
    ? "irm https://quetzal.plutokeating.beer/install.ps1 | iex"
    : "curl -fsSL https://quetzal.plutokeating.beer/install | bash";

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <p className="eyebrow">Quetzalcoatl</p>
          <h1>{t.download.title}</h1>
          <p className="lead">{m.intro}</p>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="platform-tabs" role="tablist" aria-label={t.download.choose}>
            {PLATFORM_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={platform === id}
                onClick={() => setPlatform(id)}
              >
                {m.platforms[id].label}
              </button>
            ))}
          </div>

          <div className="release-panel">
            {state.status === "loading" ? <p className="release-note">{t.download.latest}…</p> : null}
            {state.status === "error" ? (
              <div>
                <p className="release-note">{t.download.loadFailed}</p>
                <button type="button" className="btn ghost" onClick={load}>
                  {t.download.retry}
                </button>
              </div>
            ) : null}
            {state.status === "ready" && !latest ? (
              <p className="release-note">{t.download.noRelease}</p>
            ) : null}

            {latest ? (
              <>
                <h2>
                  Quetzalcoatl {version} <span className="badge">{t.download.signed}</span>
                  {prerelease ? (
                    <span className="badge">{lang === "en" ? "pre-release" : "预发布"}</span>
                  ) : null}
                </h2>
                {prerelease ? (
                  <p className="release-note">
                    {lang === "en"
                      ? "This is a pre-release. It is signed and installable, but interfaces may still change."
                      : "这是预发布版本：已签名、可安装，但接口仍可能变化。"}
                  </p>
                ) : null}
                <div className="release-meta">
                  <span>{m.platforms[platform].label}</span>
                  <span>{m.platforms[platform].note}</span>
                  {asset ? (
                    <span>
                      {t.download.size}: {formatBytes(asset.size)}
                    </span>
                  ) : null}
                </div>
                {!asset ? (
                  <p className="release-note" role="status">
                    {lang === "en"
                      ? `This pre-release ships no ${m.platforms[platform].label} build: ${version} only publishes Linux x64/arm64 CLI packages plus the hub/desktop/web bundles. macOS and Windows native clients arrive with the stable release; until then build them from source (see the repository's docs/RELEASE.md). The command below will not find an asset for this platform.`
                      : `本预发布没有 ${m.platforms[platform].label} 产物：${version} 只发布 Linux x64/arm64 命令行包，以及 hub / 桌面 / Web 打包件。macOS 与 Windows 原生端随正式版发布；在此之前请从源码构建（见仓库 docs/RELEASE.md）。下面的安装命令在这个平台上找不到可下载产物。`}
                  </p>
                ) : null}
                <div className="release-actions">
                  {assetUrl ? (
                    <a className="btn" href={assetUrl} rel="noreferrer noopener">
                      {t.download.direct}
                    </a>
                  ) : null}
                  <Link className="btn ghost" to={link("/docs/start/install")}>
                    {t.download.guide}
                  </Link>
                  <Link to={link("/docs/reference/release-signing")}>{t.footer.signing}</Link>
                </div>
                <p className="release-note">{m.cliNote}</p>

                <h3 style={{ marginTop: "24px" }}>{t.download.assets}</h3>
                <ul className="asset-list">
                  {assetsOf(latest).map((a) => {
                    const name = String(a.name ?? "");
                    const url = String(a.browser_download_url ?? "");
                    return (
                      <li key={name}>
                        {isAllowedAsset(name) ? (
                          <a href={url} rel="noreferrer noopener">
                            {name}
                          </a>
                        ) : (
                          <span>{name}</span>
                        )}
                        <span>{formatBytes(a.size)}</span>
                      </li>
                    );
                  })}
                </ul>
                <p className="release-note">{t.download.unsignedHidden}</p>
              </>
            ) : null}
          </div>

          <h2 style={{ marginTop: "32px" }}>{t.download.installing}</h2>
          <div className="codeblock">
            <div className="codeblock-head">
              <span>{isWindows ? "powershell" : "shell"}</span>
              <span>{m.platforms[platform].label}</span>
            </div>
            <pre>
              <code>{installCommand}</code>
            </pre>
          </div>
          <p className="release-note">{m.verifyText}</p>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="grid two">
            <div className="card">
              <h3>{m.cliTitle}</h3>
              <p>{m.cliNote}</p>
            </div>
            <div className="card">
              <h3>{m.requirementsTitle}</h3>
              <ul>
                {m.requirements.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="callout" style={{ marginTop: "24px" }}>
            <strong>{m.verifyTitle}</strong> {m.verifyText}{" "}
            <Link to={link("/docs/reference/release-signing")}>{t.footer.signing} →</Link>
          </div>
        </div>
      </section>
    </>
  );
}

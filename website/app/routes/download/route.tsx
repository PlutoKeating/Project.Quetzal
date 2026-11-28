import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  GITHUB_RELEASES_API,
  findPlatformAsset,
  isInstallableRelease,
  isPrerelease,
  pickLatest,
  type PlatformId,
  type Release,
} from "@shared/releases";
import { Inline, Rail } from "~/components/Blocks";
import { CommandBar } from "~/components/CommandBar";
import { ArrowRight } from "~/components/icons";
import { INSTALL_COMMAND, SOURCE_BUILD_COMMAND, langFromPath, localized, useLang } from "~/i18n/core";
import { pageMeta } from "~/lib/meta";
import { type Os, messages } from "./i18n";

export function meta({ location }: { location: { pathname: string } }) {
  const m = messages[langFromPath(location.pathname)];
  return pageMeta(`${m.metaTitle} · Quetzalcoatl`, m.metaDescription);
}

const OS_ORDER: Os[] = ["linux", "macos", "windows"];
/** 目前只有 Linux 有安装包；另外两个平台从源码构建。 */
const PACKAGED: Record<Os, PlatformId[]> = { linux: ["linux-x64", "linux-arm64"], macos: [], windows: [] };
const ARCH_LABEL: Partial<Record<PlatformId, string>> = { "linux-x64": "Linux x64", "linux-arm64": "Linux arm64" };

function detectOs(): Os {
  const hash = location.hash.slice(1);
  if (OS_ORDER.includes(hash as Os)) return hash as Os;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  return "linux";
}

function formatBytes(size: unknown): string {
  const n = typeof size === "number" ? size : Number(size);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? "B"}`;
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
  const m = messages[lang];
  const [state, setState] = useState<State>({ status: "loading" });
  const [os, setOs] = useState<Os>("linux");
  const link = (path: string) => localized(lang, path);

  const load = useCallback(() => {
    setState({ status: "loading" });
    loadReleases()
      .then((releases) => setState({ status: "ready", releases }))
      .catch(() => setState({ status: "error" }));
  }, []);

  useEffect(() => load(), [load]);
  useEffect(() => setOs(detectOs()), []);

  const installable = state.status === "ready" ? state.releases.filter(isInstallableRelease) : [];
  const latest = pickLatest(installable) ?? installable[0];
  const version = latest ? String(latest.tag_name ?? "").replace(/^v/, "") : "";
  const published = latest ? String(latest.published_at ?? "").slice(0, 10) : "";
  const packaged = PACKAGED[os];
  const fromSource = packaged.length === 0;
  const command = fromSource ? SOURCE_BUILD_COMMAND : INSTALL_COMMAND;
  const under = fromSource ? m.under.source : m.under.installer;

  const releaseMeta = latest
    ? [m.release.signed, isPrerelease(latest) ? m.release.prerelease : "", published].filter(Boolean).join(" · ")
    : state.status === "loading"
      ? m.release.loading
      : "";

  return (
    <>
      {/* 访客此刻想要的只有一样：适合这台机器的那一行命令。版本与安装包就在它下面。 */}
      <section className="qz-hero" data-qz-lit>
        <div className="qz-container qz-hero-inner">
          <h1 className="qz-display">
            {m.title.before}
            <span className="qz-wordmark" dir="ltr">
              Quetzalcoatl
            </span>
            {m.title.after}
          </h1>
          <p className="qz-lead">{m.lead}</p>

          <div className="qz-action-stack">
            <div className="qz-segmented" role="tablist" aria-label={m.choose}>
              {OS_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`os-${id}`}
                  aria-selected={os === id}
                  aria-controls="os-panel"
                  className={os === id ? "qz-segment is-active" : "qz-segment"}
                  onClick={() => setOs(id)}
                >
                  {m.os[id]}
                </button>
              ))}
            </div>
            <div className="qz-action-row">
              <CommandBar command={command} />
            </div>
            <p className="qz-meta-line">
              {under.flatMap((item, i) => [
                i > 0 ? (
                  <span key={`dot-${item}`} aria-hidden="true">
                    ·
                  </span>
                ) : null,
                <span key={item}>{item}</span>,
              ])}
            </p>
          </div>

          <div className="qz-hero-stage site-panel" role="tabpanel" id="os-panel" aria-labelledby={`os-${os}`}>
            {fromSource ? (
              <Rail
                cols={2}
                head={{ name: version ? `v${version}` : m.os[os], meta: version ? m.os[os] : undefined }}
                cells={[
                  { title: m.release.noPackage.title, text: m.release.noPackage.text },
                  { title: m.release.fromSource.title, text: m.release.fromSource.text, href: "/docs/start/install#source", line: { kind: "cmd", text: "qz connect" } },
                ]}
                lang={lang}
              />
            ) : (
              <>
                <div className="qz-rail-head">
                  <span className="qz-caret" dir="ltr" aria-hidden="true">
                    &gt;
                  </span>
                  <span dir="ltr" className="site-nowrap">
                    {version ? `v${version}` : m.os[os]}
                  </span>
                  {releaseMeta ? <span className="qz-meta">{releaseMeta}</span> : null}
                </div>
                <div className="qz-rail is-2">
                  {packaged.map((platform) => {
                    const asset = latest ? findPlatformAsset(latest, platform) : undefined;
                    const url = asset ? String(asset.browser_download_url ?? "") : "";
                    const size = asset ? formatBytes(asset.size) : "";
                    return (
                      <div key={platform} className="qz-cell">
                        <h3 dir="ltr">{ARCH_LABEL[platform] ?? platform}</h3>
                        <p>
                          {state.status === "loading"
                            ? m.release.loading
                            : state.status === "error"
                              ? m.release.failed
                              : !latest
                                ? m.release.none
                                : asset
                                  ? size
                                    ? `${m.release.size} ${size}`
                                    : m.release.signed
                                  : m.release.missing}
                        </p>
                        {url ? (
                          <div className="site-cell-action">
                            <a href={url} className="qz-btn-outline" rel="noreferrer noopener">
                              {m.release.archive}
                            </a>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {state.status === "error" ? (
                  <button type="button" className="qz-btn-outline site-gap" onClick={load}>
                    {m.release.retry}
                  </button>
                ) : null}
              </>
            )}
            <p className="qz-meta site-gap">{m.release.lead}</p>
          </div>
        </div>
      </section>

      {/* 凭什么敢用一行命令装：安装器按固定顺序做的三件事。 */}
      <section className="qz-section" data-qz-lit>
        <div className="qz-container">
          <div className="qz-section-head">
            <h2 className="qz-title">{m.steps.title}</h2>
            <p>{m.steps.lead}</p>
          </div>
          <Rail cols={3} cells={m.steps.cells} lang={lang} />
          <div className="site-gap">
            <Link to={link("/docs/reference/release-signing")} className="qz-link-arrow">
              <span>{m.steps.verify}</span>
              <ArrowRight />
            </Link>
          </div>
        </div>
      </section>

      <section className="qz-close" data-qz-lit>
        <div className="qz-container qz-close-inner">
          <h2 className="qz-monument">{m.close.title}</h2>
          <p className="qz-close-note">
            <Inline text={m.close.note} lang={lang} />
          </p>
          <div className="qz-action-stack">
            <div className="qz-action-row">
              <Link to={link("/docs/start/connect")} className="qz-btn-outline">
                <span>{m.close.connect}</span>
                <ArrowRight />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

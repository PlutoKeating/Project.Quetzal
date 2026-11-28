import { Link } from "react-router";
import { Rail } from "~/components/Blocks";
import { CommandBar } from "~/components/CommandBar";
import { ArrowRight } from "~/components/icons";
import { Figure } from "~/diagrams/Figure";
import { LoopCompact, LoopWide } from "~/diagrams/Loop";
import { HostTerminal, SeaStage } from "~/diagrams/Stage";
import { TrajectoryCompact, TrajectoryWide } from "~/diagrams/Trajectory";
import { INSTALL_COMMAND, langFromPath, localized, useLang } from "~/i18n/core";
import { pageMeta } from "~/lib/meta";
import { messages } from "./i18n";

export function meta({ location }: { location: { pathname: string } }) {
  const m = messages[langFromPath(location.pathname)];
  return pageMeta(m.metaTitle, m.metaDescription);
}

export default function Home() {
  const lang = useLang();
  const m = messages[lang];
  const link = (path: string) => localized(lang, path);
  return (
    <>
      {/* 访客此刻想知道：这是什么，怎么装。一句话、一行命令、一块舞台。 */}
      <section className="qz-hero" data-qz-lit>
        <div className="qz-container qz-hero-inner">
          <h1 className="qz-display">{m.hero.title}</h1>
          <p className="qz-lead">{m.hero.lead}</p>

          <div className="qz-action-stack">
            <div className="qz-action-row">
              <CommandBar command={INSTALL_COMMAND} />
              <Link to={link("/docs")} className="qz-link-arrow">
                <span>{m.hero.docs}</span>
                <ArrowRight />
              </Link>
            </div>
            <p className="qz-meta-line">
              <code>{m.hero.meta.join(" · ")}</code>
            </p>
          </div>

          <div className="qz-hero-stage">
            <div className="qz-stage-wrap" data-qz-rim>
              <div className="qz-stage-rim" aria-hidden="true" />
              <div className="qz-stage" role="group" aria-label={m.stage.label}>
                <div className="qz-stage-pane">
                  <div className="qz-stage-label">
                    <span className="qz-led" aria-hidden="true" />
                    <span>{m.stage.host}</span>
                  </div>
                  <div className="site-stage-art">
                    <HostTerminal lang={lang} />
                  </div>
                  <ul className="qz-milestones">
                    {m.stage.steps.map((step, i) => (
                      <li key={step} className={i === 1 ? "is-active" : undefined}>
                        <span className={i === 1 ? "qz-tick is-ice" : "qz-tick"} aria-hidden="true" />
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="qz-stage-divider" aria-hidden="true" />
                <div className="qz-stage-pane">
                  <div className="qz-stage-label">
                    <span className="qz-dot" aria-hidden="true" />
                    <span>{m.stage.sea}</span>
                  </div>
                  <div className="site-stage-art">
                    <SeaStage lang={lang} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 它怎么工作：一张回路图，三站与下面的三格逐列对齐。 */}
      <section className="qz-section" data-qz-lit>
        <div className="qz-container">
          <div className="qz-section-head">
            <h2 className="qz-title">{m.loop.title}</h2>
            <p>{m.loop.lead}</p>
          </div>
          <Figure bare wide={<LoopWide lang={lang} />} compact={<LoopCompact lang={lang} />} />
          <div className="site-gap">
            <Rail cols={3} cells={m.loop.cells} lang={lang} />
          </div>
        </div>
      </section>

      {/* 我在哪里碰到它：按离手的远近排开的四层。 */}
      <section className="qz-section" data-qz-lit>
        <div className="qz-container">
          <div className="qz-section-head">
            <h2 className="qz-title">{m.layers.title}</h2>
            <p>{m.layers.lead}</p>
          </div>
          <Rail cols={4} head={m.layers.head} cells={m.layers.cells} lang={lang} />
          <div className="qz-prompt-rail site-gap">
            <div className="qz-prompt-text">
              <span className="qz-caret" dir="ltr" aria-hidden="true">
                &gt;
              </span>
              <span>{m.layers.saying}</span>
            </div>
            <Link to={link("/docs/guide/in-host")} className="qz-btn-outline">
              <span>{m.layers.all}</span>
              <ArrowRight />
            </Link>
          </div>
        </div>
      </section>

      {/* 它不是什么：一张轨迹对比，上面是「又一个聊天框」，下面是它。 */}
      <section className="qz-section" data-qz-lit>
        <div className="qz-container">
          <div className="qz-section-head">
            <h2 className="qz-title">{m.not.title}</h2>
            <p>{m.not.lead}</p>
          </div>
          <Figure bare wide={<TrajectoryWide id="boundary" lang={lang} />} compact={<TrajectoryCompact id="boundary" lang={lang} />} />
          <p className="qz-meta site-gap">{m.not.also}</p>
        </div>
      </section>

      <section className="qz-close" data-qz-lit>
        <div className="qz-container qz-close-inner">
          <h2 className="qz-monument">{m.close.title}</h2>
          <p className="qz-close-note">{m.close.note}</p>
          <div className="qz-action-stack">
            <div className="qz-action-row">
              <Link to={link("/docs/start/install")} className="qz-btn-outline">
                <span>{m.close.install}</span>
                <ArrowRight />
              </Link>
              <Link to={link("/download")} className="qz-link-arrow">
                <span>{m.close.download}</span>
                <ArrowRight />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

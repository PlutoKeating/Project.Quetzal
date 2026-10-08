import type { Route } from "./+types/route";
import { Link } from "react-router";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { Breath, ButtonAnchor, ButtonLink, Container, Heading, OrbMark, Phrases, Reveal, Section, StatusDot, cx } from "~/design-system/components";
import { GITHUB_REPO } from "~/components/i18n";
import { BodySenses, MeshBodies, SkillTools, SoulGit, WakeTimeline } from "~/routes/features/illustrations";
import { messages as featureMessages } from "~/routes/features/i18n";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { property: "og:title", content: m.title }, { property: "og:description", content: m.description }];
};

/** 章节的小标签：呼吸的状态灯 + 一个词。全页只用这一种标签。 */
function Tag({ children }: { children: React.ReactNode }) {
  return <p className="flex items-center justify-center gap-2 text-sm font-medium tracking-wide text-secondary-fg"><StatusDot alive />{children}</p>;
}

export default function Home() {
  const t = useMessages(messages);
  const f = useMessages(featureMessages);
  const lang = useLang();
  /** 每一章的示意图与亮点页同一张，图里的文字取亮点页的文案。 */
  const art = (id: string) => {
    const s = f.stories.find((x) => x.id === id);
    if (!s) return null;
    switch (id) {
      case "soul": return <SoulGit t={s.art as never} />;
      case "mesh": return <MeshBodies t={s.art as never} />;
      case "waking": return <WakeTimeline t={s.art as never} />;
      case "body": return <BodySenses t={s.art as never} />;
      case "tools": return <SkillTools t={s.art as never} />;
      default: return null;
    }
  };
  const link = "text-link underline-offset-4 hover:underline";

  return (
    <>
      {/* Hero：标语（固定）、一句话说清它是什么、入口；右侧是一段示例对话，当作「产品照」 */}
      <section className="relative overflow-hidden border-b border-border">
        <Breath className="-right-32 -top-24 sm:-right-16 sm:top-0 landscape:short:-top-40" />
        <Container className="relative grid min-h-[calc(100dvh-var(--ds-header-height))] items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.1fr_1fr] lg:gap-16 short:min-h-0 short:py-10"> {/* ds-allow：高度表达式只引用变量；栅格比例 */}
          <div className="flex flex-col gap-6">
            <p className="flex items-center gap-3">
              <OrbMark size={14} />
              <span className="text-lg font-medium tracking-wide text-fg">Quetzal</span>
              <span aria-hidden className="h-4 w-px bg-border-strong" />
              <span className="text-xs font-medium uppercase tracking-wide text-secondary-fg">{t.hero.eyebrow}</span>
            </p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">{t.hero.title}</h1>
            <p className="-mt-3 text-xl italic text-fg-muted">{t.hero.titleAlt}</p>
            <p className="max-w-prose text-xl text-fg sm:text-2xl"><Phrases text={t.hero.lead} /></p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.hero.download}</ButtonLink>
              <ButtonLink variant="ghost" size="lg" to={localized(lang, "/features")}>{t.hero.features} →</ButtonLink>
            </div>
            <p className="text-sm text-fg-subtle">{t.hero.platforms}</p>
          </div>
          {/* 构造的一段对话，只演示已经写进代码的做法：记得你说过的事、醒着时自己找你 */}
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-lg sm:p-7">
            <ol className="flex flex-col gap-3">
              {t.hero.chat.map((c, i) => (
                c.from === "event"
                  ? <li key={i} className="py-1 text-center text-xs text-fg-subtle tabular-nums">{c.text}</li>
                  : <li key={i} className={cx("max-w-[85%] rounded-2xl px-4 py-3 text-pretty", c.from === "you" ? "self-end bg-secondary-soft text-fg" : "self-start border border-border bg-bg-elevated text-fg")}>{c.text}</li> /* ds-allow：气泡最大宽度 */
              ))}
            </ol>
          </div>
        </Container>
      </section>

      {/* 章节：许多身体接着 hero 的「住在你所有设备上」，其余与亮点页同一顺序；每章一句标题、一句话、一张图（宽度上限在 Frame 里） */}
      {t.chapters.map((c, i) => (
        <Section key={c.id} tone={i % 2 ? "elevated" : "plain"} className="py-24 sm:py-36">
          <Container className="flex flex-col items-center gap-14 text-center">
            <Reveal className="flex max-w-prose flex-col items-center gap-6">
              <Tag>{c.tag}</Tag>
              <Heading size="xl"><Phrases text={c.heading} /></Heading>
              <p className="text-xl text-fg-muted"><Phrases text={c.lead} /></p>
              {"note" in c && c.note && <Link to={localized(lang, c.noteLink)} className={cx("text-sm", link)}>{c.note} →</Link>}
              <Link to={`${localized(lang, "/features")}#${c.id}`} className={cx("text-sm", link)}>{t.more} →</Link>
            </Reveal>
            <Reveal delay={1} className="w-full text-left">{art(c.id)}</Reveal>
          </Container>
        </Section>
      ))}

      {/* 你说了算：回应「安全吗」。三件事 + 一句话链到「信任与边界」 */}
      <Section tone={t.chapters.length % 2 ? "elevated" : "plain"} className="py-24 sm:py-36">
        <Container className="flex flex-col items-center gap-16 text-center">
          <Reveal className="flex max-w-prose flex-col items-center gap-6">
            <Tag>{t.control.tag}</Tag>
            <Heading size="xl"><Phrases text={t.control.heading} /></Heading>
            <p className="text-xl text-fg-muted"><Phrases text={t.control.lead} /></p>
          </Reveal>
          <dl className="grid w-full max-w-content gap-10 sm:grid-cols-3">
            {t.control.facts.map((x, i) => (
              <Reveal key={x.title} delay={i as 0 | 1 | 2} className="flex flex-col gap-2">
                <dt className="text-lg font-semibold text-fg">{x.title}</dt>
                <dd className="text-fg-muted"><Phrases text={x.text} /></dd>
              </Reveal>
            ))}
          </dl>
          <p className="max-w-prose text-sm text-fg-subtle"><Phrases text={t.control.honest} /> <Link to={localized(lang, "/docs/guide/trust")} className={cx("whitespace-nowrap", link)}>{t.control.more} →</Link></p>
        </Container>
      </Section>

      {/* 开始：三个平台各链到下载页对应的一节 */}
      <Section className="py-24 sm:py-36">
        <Container className="flex flex-col items-center gap-8 text-center">
          <OrbMark size={40} />
          <Heading size="xl"><Phrases text={t.start.heading} /></Heading>
          <p className="max-w-prose text-xl text-fg-muted"><Phrases text={t.start.lead} /></p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.start.download}</ButtonLink>
            <ButtonLink variant="secondary" size="lg" to={localized(lang, "/docs")}>{t.start.docs}</ButtonLink>
          </div>
          <p className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
            {t.start.platforms.map((p) => <Link key={p.id} to={`${localized(lang, "/download")}#${p.id}`} className={link}>{p.name}</Link>)}
          </p>
          <p className="text-sm text-fg-subtle">{t.start.foot} · <ButtonAnchor variant="ghost" size="sm" href={GITHUB_REPO} target="_blank" rel="noreferrer noopener" className="h-auto px-1 py-0">GitHub ↗</ButtonAnchor></p>
        </Container>
      </Section>
    </>
  );
}

import type { Route } from "./+types/route";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { ButtonLink, Container, Eyebrow, Heading, Lead, Reveal, Section } from "~/design-system/components";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

export default function Features() {
  const t = useMessages(messages);
  const lang = useLang();
  return (
    <>
      <Section tight className="border-b border-border">
        <Container className="flex max-w-prose flex-col gap-4">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Heading as="h1" size="xl">{t.heading}</Heading>
          <Lead>{t.lead}</Lead>
        </Container>
      </Section>
      <Section>
        <Container className="grid gap-12 lg:grid-cols-[14rem_1fr]">
          <nav aria-label={t.toc} className="hidden lg:block">
            <div className="sticky top-[calc(var(--ds-header-height)+1.5rem)] flex flex-col gap-1 text-sm"> {/* ds-allow：偏移只引用变量 */}
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.toc}</p>
              {t.features.map((f, i) => (
                <a key={f.id} href={`#${f.id}`} className="rounded-md px-2 py-1 text-fg-muted transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover hover:text-fg">
                  <span className="mr-2 font-mono text-xs text-fg-subtle">{String(i + 1).padStart(2, "0")}</span>{f.name}
                </a>
              ))}
            </div>
          </nav>
          <div className="flex flex-col divide-y divide-border">
            {t.features.map((f, i) => (
              <Reveal key={f.id} as="article" className="scroll-mt-(--ds-header-height) grid gap-4 py-10 first:pt-0 md:grid-cols-[4rem_1fr] short:py-6">
                <span className="font-mono text-2xl text-secondary-fg">{String(i + 1).padStart(2, "0")}</span>
                <div className="flex flex-col gap-4" id={f.id}>
                  <Heading as="h2" size="md">{f.name}</Heading>
                  <p className="max-w-prose text-lg text-fg-muted text-pretty">{f.summary}</p>
                  {f.code && <pre className="overflow-x-auto rounded-lg border border-border bg-code-bg px-4 py-3 font-mono text-sm text-code-fg">{f.code}</pre>}
                  {f.details.length > 0 && (
                    <ul className="flex max-w-prose flex-col gap-2 text-sm text-fg-muted">
                      {f.details.map((d) => (
                        <li key={d} className="grid grid-cols-[0.75rem_1fr] gap-2"><span aria-hidden className="mt-2 inline-block size-1.5 rounded-full bg-secondary" /><span>{d}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              </Reveal>
            ))}
          </div>
        </Container>
      </Section>
      <Section tone="elevated" tight>
        <Container className="flex flex-wrap gap-3">
          <ButtonLink variant="accent" to={localized(lang, "/download")}>{t.cta.download}</ButtonLink>
          <ButtonLink variant="secondary" to={localized(lang, "/docs")}>{t.cta.docs}</ButtonLink>
        </Container>
      </Section>
    </>
  );
}

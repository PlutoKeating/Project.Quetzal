import { Container, Eyebrow, Heading, Lead, Section } from "~/design-system/components";

export type ArticleSection = { heading: string; paragraphs: readonly string[]; bullets?: readonly string[] };

/** About / Terms / Privacy 共用的长文版式：窄栏、分节、页首说明与更新日期。 */
export function Article({ eyebrow, title, lead, updated, sections, children }: { eyebrow: string; title: string; lead?: string; updated?: string; sections: readonly ArticleSection[]; children?: React.ReactNode }) {
  return (
    <>
      <Section tight className="border-b border-border">
        <Container width="prose" className="flex flex-col gap-4">
          <Eyebrow>{eyebrow}</Eyebrow>
          <Heading as="h1" size="lg">{title}</Heading>
          {lead && <Lead>{lead}</Lead>}
          {updated && <p className="text-sm text-fg-subtle">{updated}</p>}
        </Container>
      </Section>
      <Section>
        <Container width="prose" className="flex flex-col gap-10">
          {sections.map((s) => (
            <section key={s.heading} className="flex flex-col gap-3">
              <Heading as="h2" size="sm">{s.heading}</Heading>
              {s.paragraphs.map((p) => <p key={p} className="text-fg-muted text-pretty">{p}</p>)}
              {s.bullets && (
                <ul className="flex flex-col gap-2 text-fg-muted">
                  {s.bullets.map((b) => <li key={b} className="grid grid-cols-[0.75rem_1fr] gap-2"><span aria-hidden className="mt-2.5 inline-block size-1.5 rounded-full bg-secondary" /><span>{b}</span></li>)}
                </ul>
              )}
            </section>
          ))}
          {children}
        </Container>
      </Section>
    </>
  );
}

import { Link } from "react-router";
import { DocShell } from "~/components/DocShell";
import { docMeta } from "~/components/DocPage";
import { localized, useChrome, useLang } from "~/i18n/core";
import { DOC_NAV, navGroups } from "~/lib/pages";
import { messages } from "./i18n";

export const meta = ({ location }: { location: { pathname: string } }) => docMeta(messages, location);

const SECTION_LABEL = { start: "start", guide: "guide", advanced: "advanced", reference: "reference" } as const;

export default function Page() {
  const lang = useLang();
  const { t } = useChrome();
  const doc = messages[lang].doc;
  const groups = navGroups();
  return (
    <DocShell path="/docs" doc={doc}>
      <div className="cards">
        {groups.flatMap((group) =>
          group.items
            .filter((item) => item.path !== "/docs")
            .map((item) => (
              <div key={item.path}>
                <span className="kicker">{t.docsSections[SECTION_LABEL[group.section]]}</span>
                <h3>
                  <Link to={localized(lang, item.path)}>{item.label[lang]}</Link>
                </h3>
                <p>
                  {DOC_NAV.find((d) => d.path === item.path)?.section === "reference" ? t.footer.reference : t.footer.learn}
                </p>
              </div>
            )),
        )}
      </div>
    </DocShell>
  );
}

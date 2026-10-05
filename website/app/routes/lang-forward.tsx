import type { Route } from "./+types/lang-forward";
import { LANGS, FORWARD_SCRIPT, LANG_LABEL } from "~/i18n/core";

export const meta: Route.MetaFunction = () => [{ title: "Quetzal" }, { name: "robots", content: "noindex" }];

/** /device 与 /account：按访客语言转到 /:lang/account/…，保留查询参数（绑定码）。预渲染为静态页，脚本内联，首屏即跳。 */
export default function LangForward() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-6 p-6">
      <script dangerouslySetInnerHTML={{ __html: FORWARD_SCRIPT }} />
      <noscript>
        <ul className="flex gap-6 text-lg">
          {LANGS.map((l) => (
            <li key={l}><a className="text-accent underline" href={`/${l}/account/device`}>{LANG_LABEL[l]}</a></li>
          ))}
        </ul>
      </noscript>
    </main>
  );
}

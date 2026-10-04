import type { Route } from "./+types/lang-redirect";
import { LANGS, REDIRECT_SCRIPT, LANG_LABEL } from "~/i18n/core";

export const meta: Route.MetaFunction = () => [{ title: "Quetzal" }, { name: "robots", content: "noindex" }];

/** 根路径：按访客偏好跳到 /zh 或 /en。预渲染为静态页，脚本内联，首屏即跳。 */
export default function LangRedirect() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-6 p-6">
      <script dangerouslySetInnerHTML={{ __html: REDIRECT_SCRIPT }} />
      <noscript>
        <ul className="flex gap-6 text-lg">
          {LANGS.map((l) => (
            <li key={l}><a className="text-accent underline" href={`/${l}`}>{LANG_LABEL[l]}</a></li>
          ))}
        </ul>
      </noscript>
    </main>
  );
}

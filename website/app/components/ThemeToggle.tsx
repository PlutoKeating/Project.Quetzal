import { useEffect, useState } from "react";
import { useMessages } from "~/i18n/core";
import { shellMessages } from "./i18n";
import { cx } from "~/design-system/components";

type Theme = "system" | "light" | "dark";
const KEY = "quetzal.theme";

/** 内联到 <head> 的脚本：首屏前应用已保存的外观，避免闪烁。 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})();`;

function apply(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useMessages(shellMessages).theme;
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") setTheme(v); } catch { /* ignore */ }
  }, []);
  const order: Theme[] = ["system", "light", "dark"];
  const next = () => { const n = order[(order.indexOf(theme) + 1) % order.length]; setTheme(n); apply(n); };
  const icon = theme === "light" ? "☼" : theme === "dark" ? "☾" : "◐";
  return (
    <button type="button" onClick={next} aria-label={`${t.label}: ${t[theme]}`} title={`${t.label}: ${t[theme]}`}
      className={cx("inline-flex size-9 items-center justify-center rounded-full border border-border text-fg-muted transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover hover:text-fg", className)}>
      <span aria-hidden className="text-base leading-none">{icon}</span>
    </button>
  );
}

import { useEffect, useRef, useState } from "react";
import { useChrome } from "~/i18n/core";

type Variant = "qz-btn-white" | "qz-btn-outline" | "qz-btn-copy";

/** 把 CSS 时长读成毫秒。构建时压缩器会把 1800ms 改写成 1.8s，两种单位都要认。 */
export function parseDuration(raw: string): number {
  const text = raw.trim();
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return 0;
  return text.endsWith("ms") ? value : value * 1000;
}

/** 「已复制」停留多久由设计系统的 --qz-duration-feedback 决定，这里只读不写。 */
function feedbackMs(): number {
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue("--qz-duration-feedback"));
}

/** 复制按钮：成功后加 .is-copied 并换成「已复制」，到时复原。只有颜色在变。 */
export function CopyButton({ text, variant, label, doneLabel }: { text: string; variant: Variant; label?: string; doneLabel?: string }) {
  const { t } = useChrome();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), feedbackMs());
  };

  return (
    <button type="button" className={copied ? `${variant} is-copied` : variant} onClick={copy}>
      <span aria-live="polite">{copied ? (doneLabel ?? t.copy.done) : (label ?? t.copy.idle)}</span>
    </button>
  );
}

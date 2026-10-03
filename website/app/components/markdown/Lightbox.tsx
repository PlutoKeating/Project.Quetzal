import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMessages } from "~/i18n/core";
import { mdMessages } from "./i18n";

export type Natural = { w: number; h: number };

/** 全屏查看（图表与图片共用）：按钮缩放 + 双向滚动；Esc 或点按空白处关闭。children 按给定的像素尺寸渲染内容。 */
export function Lightbox({ natural, onClose, children }: { natural: Natural; onClose: () => void; children: (size: { width: number; height: number }) => ReactNode }) {
  const t = useMessages(mdMessages);
  const [scale, setScale] = useState(() => {
    if (typeof window === "undefined") return 1;
    const fit = Math.min((window.innerWidth - 48) / natural.w, (window.innerHeight - 120) / natural.h);
    return Math.max(0.5, Math.min(1.5, fit));
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const btn = "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover";
  return createPortal(
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex flex-col bg-overlay backdrop-blur-glass">
      <div className="flex items-center justify-end gap-2 p-3">
        <button type="button" className={btn} onClick={() => setScale((s) => Math.max(0.25, s / 1.25))} aria-label={t.zoomOut}>−</button>
        <button type="button" className={btn} onClick={() => setScale(1)}>{t.zoomReset}</button>
        <button type="button" className={btn} onClick={() => setScale((s) => Math.min(6, s * 1.25))} aria-label={t.zoomIn}>+</button>
        <button type="button" className={btn} onClick={onClose}>{t.close}</button>
      </div>
      <div className="flex-1 overflow-auto p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="inline-block min-w-full rounded-lg bg-surface p-4">
          {children({ width: Math.round(natural.w * scale), height: Math.round(natural.h * scale) })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 文档里的图片：点按放大（SVG 架构图在手机上缩得太小，必须能放大看）。 */
export function ZoomImage({ alt, src, ...rest }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const t = useMessages(mdMessages);
  const ref = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [open, setOpen] = useState(false);
  // 预渲染的图片可能在水合前就已加载完成（onLoad 不会再触发），点按时直接读取尺寸
  const openBox = () => {
    const i = ref.current;
    const n = natural ?? (i?.naturalWidth ? { w: i.naturalWidth, h: i.naturalHeight } : null);
    if (!n) return;
    setNatural(n);
    setOpen(true);
  };
  return (
    <>
      <button type="button" className="md-zoom block w-full cursor-zoom-in" title={t.mermaidZoom} onClick={openBox}>
        <img ref={ref} loading="lazy" decoding="async" alt={alt ?? ""} src={src} {...rest} />
      </button>
      {open && natural && (
        <Lightbox natural={natural} onClose={() => setOpen(false)}>
          {(size) => <img alt={alt ?? ""} src={src} style={size} className="block max-w-none" />}
        </Lightbox>
      )}
    </>
  );
}

// 设计系统没有图标库：只有这几个内联线形图标，1.3–1.4px 描边、圆头圆角、currentColor。

/** 方向箭头。RTL 下由 .qz-dir-arrow 自动翻转。 */
export function ArrowRight({ className = "qz-dir-arrow" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className={className}>
      <path d="M3.5 8H12.5M9 4.5L12.5 8L9 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowLeft() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className="qz-dir-arrow">
      <path d="M12.5 8H3.5M7 4.5L3.5 8L7 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

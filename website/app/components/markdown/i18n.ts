import { defineMessages } from "~/i18n/core";

export const mdMessages = defineMessages({
  zh: {
    copy: "复制",
    copied: "已复制",
    mermaidFailed: "图表渲染失败，以下为源码：",
    mermaidLoading: "图表加载中…",
    mermaidScroll: "图较宽，可左右滑动",
    mermaidZoom: "放大查看",
    zoomIn: "放大",
    zoomOut: "缩小",
    zoomReset: "原始大小",
    close: "关闭",
    alert: { note: "说明", tip: "提示", important: "重要", warning: "注意", caution: "警告" },
    anchor: "本节链接",
  },
  en: {
    copy: "Copy",
    copied: "Copied",
    mermaidFailed: "Diagram failed to render; source shown below:",
    mermaidLoading: "Loading diagram…",
    mermaidScroll: "Wide diagram, scroll sideways",
    mermaidZoom: "Enlarge",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomReset: "Actual size",
    close: "Close",
    alert: { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" },
    anchor: "Link to this section",
  },
});

import type { ReactNode } from "react";
import type { Lang } from "~/i18n/core";
import type { FigureId } from "~/lib/content";
import { ExportCompact, ExportWide, GovernanceCompact, GovernanceWide, LevelsCompact, LevelsWide, TopologyCompact, TopologyWide } from "./Concepts";
import { TrajectoryCompact, TrajectoryWide } from "./Trajectory";

/**
 * 一张图的宽、窄两版。SVG 里的字不会自己换行，缩得太小就读不了，
 * 所以容器窄于 640px 时换成竖排的那一版（按容器宽度切换，见 site.css）。
 * bare：不要 .qz-figure 的上下留白，用在图与下面的栅格连成一体的地方。
 */
export function Figure({ wide, compact, bare }: { wide: ReactNode; compact: ReactNode; bare?: boolean }) {
  return (
    <figure className={bare ? "site-figure site-figure-bare" : "qz-figure site-figure"}>
      <div className="site-figure-wide">{wide}</div>
      <div className="site-figure-compact">{compact}</div>
    </figure>
  );
}

export function FigureById({ id, lang }: { id: FigureId; lang: Lang }) {
  switch (id) {
    case "journey":
    case "installer":
    case "session":
      return <Figure wide={<TrajectoryWide id={id} lang={lang} />} compact={<TrajectoryCompact id={id} lang={lang} />} />;
    case "governance":
      return <Figure wide={<GovernanceWide lang={lang} />} compact={<GovernanceCompact lang={lang} />} />;
    case "topology":
      return <Figure wide={<TopologyWide lang={lang} />} compact={<TopologyCompact lang={lang} />} />;
    case "levels":
      return <Figure wide={<LevelsWide lang={lang} />} compact={<LevelsCompact lang={lang} />} />;
    case "export":
      return <Figure wide={<ExportWide lang={lang} />} compact={<ExportCompact lang={lang} />} />;
  }
}

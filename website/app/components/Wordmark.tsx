import { StatusDot } from "~/design-system/components";

/** 字标：名字 + 一盏小灯。灯是全站唯一常亮的琥珀。 */
export function Wordmark({ large }: { large?: boolean }) {
  return (
    <span className={large ? "flex items-center gap-3 text-2xl font-semibold tracking-tight" : "flex items-center gap-2 text-base font-semibold tracking-tight"}>
      <StatusDot alive />
      <span>Windler</span>
    </span>
  );
}

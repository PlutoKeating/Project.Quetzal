import { OrbMark } from "~/design-system/components";

/** 字标：名字 + 光团（与控制台图标、favicon 同一颗球）。 */
export function Wordmark({ large }: { large?: boolean }) {
  return (
    <span className={large ? "flex items-center gap-2 text-2xl font-semibold tracking-tight" : "flex items-center gap-1.5 text-base font-semibold tracking-tight"}>
      <OrbMark size={large ? 36 : 28} className="-mx-1" />
      <span>Quetzal</span>
    </span>
  );
}

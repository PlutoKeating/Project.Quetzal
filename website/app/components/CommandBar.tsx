import { CopyButton } from "./CopyButton";

/** 命令条：一行等宽命令 + 右侧的白色主按钮。一页只放一个。 */
export function CommandBar({ command }: { command: string }) {
  return (
    <div className="qz-command-bar" dir="ltr">
      <code>{command}</code>
      <CopyButton text={command} variant="qz-btn-white" />
    </div>
  );
}

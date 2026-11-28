import { DocPage } from "~/components/DocShell";
import { docMeta } from "~/lib/meta";
import { messages } from "./i18n";

export const meta = ({ location }: { location: { pathname: string } }) => docMeta(messages, location);

export default function Page() {
  return <DocPage path="/docs/reference/commands" messages={messages} />;
}

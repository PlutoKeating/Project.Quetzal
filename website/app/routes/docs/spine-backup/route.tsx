import { DocPage, docMeta } from "~/components/DocPage";
import { messages } from "./i18n";

export const meta = ({ location }: { location: { pathname: string } }) => docMeta(messages, location);

export default function Page() {
  return <DocPage path="/docs/reference/spine-backup" messages={messages} />;
}

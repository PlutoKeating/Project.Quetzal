// 账户区的共用外壳：像控制台一样的子页面集合（概览 · 批准设备 · 控制台登录 · 账户设置）。
// 页面预渲染时只有外壳；水合后向同步服务读取登录状态，没登录就显示登录卡片（登录后回到当前地址）。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { localized, useLang, useMessages, type Lang } from "~/i18n/core";
import { Button, ButtonAnchor, Card, Container, Eyebrow, Heading, Lead, Section, cx } from "~/design-system/components";
import { SyncError, loginUrl, sync, type SessionInfo } from "~/lib/sync";
import { accountMessages } from "./i18n";

const tabs = [
  { key: "overview", path: "/account" },
  { key: "device", path: "/account/device" },
  { key: "consoles", path: "/account/consoles" },
  { key: "settings", path: "/account/settings" },
] as const;

export type Load<T> = { status: "loading" } | { status: "error"; error: SyncError } | { status: "ready"; data: T };

/** 读一次数据，可重试。unauthorized 也作为 error 返回，由外壳显示登录。 */
export function useLoad<T>(load: () => Promise<T>): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const run = useCallback(() => {
    setState({ status: "loading" });
    load().then((data) => setState({ status: "ready", data }), (e: unknown) => setState({ status: "error", error: e instanceof SyncError ? e : new SyncError("network") }));
  }, [load]);
  useEffect(() => run(), [run]);
  return [state, run];
}

/** 相对时间（刚刚 / n 分钟前 / n 小时前 / n 天前）。 */
export function ago(t: (typeof accountMessages)[Lang]["time"], ms: number): string {
  const d = Math.max(0, Date.now() - ms) / 60_000;
  if (d < 1) return t.now;
  if (d < 60) return t.minutes.replace("{n}", String(Math.floor(d)));
  if (d < 1440) return t.hours.replace("{n}", String(Math.floor(d / 60)));
  return t.days.replace("{n}", String(Math.floor(d / 1440)));
}

export function errorText(t: (typeof accountMessages)[Lang], e: SyncError): string {
  if (e.code === "network") return t.state.network;
  return t.errors[e.code] ?? `${t.state.error}${e.code}`;
}

export function ErrorNote({ error, onRetry }: { error: SyncError; onRetry?: () => void }) {
  const t = useMessages(accountMessages);
  return (
    <Card className="flex flex-col items-start gap-3">
      <p className="text-danger">{errorText(t, error)}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>{t.state.retry}</Button>}
    </Card>
  );
}

/** 账户区外壳：标题、子导航、登录拦截。children 只在登录后渲染，拿到当前用户。 */
export function AccountShell({ heading, lead, children }: { heading: string; lead?: string; children: (session: SessionInfo & { user: NonNullable<SessionInfo["user"]> }) => ReactNode }) {
  const t = useMessages(accountMessages);
  const lang = useLang();
  const { search, pathname } = useLocation();
  const here = pathname.replace(/\/+$/, ""); // 托管时目录页会补上尾斜杠
  const loadSession = useCallback(() => sync.session(), []);
  const [session, retry] = useLoad(loadSession);
  const failed = new URLSearchParams(search).get("login") === "failed";

  return (
    <Section tight>
      <Container className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <Heading as="h1" size="lg">{heading}</Heading>
            {session.status === "ready" && session.data.user && (
              <p className="text-sm text-fg-muted">{t.signedInAs} · <span className="text-fg">{session.data.user.name || session.data.user.login}</span> <span className="text-fg-subtle">(GitHub {session.data.user.login})</span></p>
            )}
          </div>
          {lead && <Lead className="max-w-prose">{lead}</Lead>}
        </div>
        <nav aria-label={t.eyebrow} className="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-px">
          {tabs.map((x) => {
            const to = localized(lang, x.path), active = here === to;
            return (
              <Link key={x.key} to={to} aria-current={active ? "page" : undefined}
                className={cx("shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors duration-(--ds-duration-fast)", active ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")}>
                {t.nav[x.key]}
              </Link>
            );
          })}
        </nav>
        {session.status === "loading" && <p className="text-fg-muted">{t.state.loading}</p>}
        {session.status === "error" && <ErrorNote error={session.error} onRetry={retry} />}
        {session.status === "ready" && !session.data.user && <LoginCard enabled={session.data.loginEnabled} failed={failed} />}
        {session.status === "ready" && session.data.user && children(session.data as SessionInfo & { user: NonNullable<SessionInfo["user"]> })}
      </Container>
    </Section>
  );
}

function LoginCard({ enabled, failed }: { enabled: boolean; failed: boolean }) {
  const t = useMessages(accountMessages);
  // 登录后回到当前地址（含绑定码），去掉 login=failed
  const back = () => { const u = new URL(window.location.href); u.searchParams.delete("login"); return u.toString(); };
  return (
    <Card className="flex max-w-prose flex-col items-start gap-4">
      <Heading as="h2" size="sm">{t.login.heading}</Heading>
      <p className="text-fg-muted">{t.login.lead}</p>
      {failed && <p className="text-danger">{t.login.failed}</p>}
      {enabled ? <ButtonAnchor variant="primary" href="#" onClick={(e) => { e.preventDefault(); window.location.assign(loginUrl(back())); }}>{t.login.button}</ButtonAnchor>
        : <p className="text-warning">{t.login.disabled}</p>}
    </Card>
  );
}

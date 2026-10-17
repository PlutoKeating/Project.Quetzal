---
title: Plugins
description: Give the agent a browser, email, calendars, GitHub, Notion and more: MCP tool sources, Claude Code plugins and Agent Skills, one-click install, a checklist before anything is added, and outward actions only with your approval.
---

## What plugins are

Plugins give the agent tools it does not have. Quetzal follows the three formats the industry already uses instead of inventing its own:

- **MCP tool sources**: [Model Context Protocol](https://modelcontextprotocol.io) servers. One can be a command running on this device (stdio) or a remote address (Streamable HTTP, or the legacy HTTP+SSE). Its tools, resources (files, documents, records) and prompt templates all reach the agent.
- **Claude Code plugins**: a folder or git repository with `.claude-plugin/plugin.json`, which can contain skills (`skills/`), MCP servers (`.mcp.json`), commands (`commands/`) and sub-agent definitions (`agents/`).
- **Agent Skills**: guides in the form `skills/<name>/SKILL.md`, the same format as the [skills](/docs/guide/tools) the agent writes itself.

Plugins are managed under **Control → Advanced → Plugins**.

## One-click install from the recommended list

The "Recommended" list at the bottom of the Plugins page is a curated list built into the runtime. It only includes public, well-known projects, and each entry names its maintainer and license:

| For | Plugins |
|---|---|
| Browser and web forms | Playwright (official, Microsoft, Apache-2.0): open pages, click, type, fill in and submit forms, take screenshots |
| Email | Any IMAP / SMTP mailbox (including Gmail and Outlook with app passwords) · Google Workspace (Gmail, Calendar, Drive) · Microsoft 365 / Outlook |
| Calendar | Google Calendar · CalDAV (iCloud, Nextcloud, Fastmail, self-hosted servers) · Outlook calendar (part of Microsoft 365) |
| Development | GitHub (official remote server, with your personal access token) · Linear · Sentry · Git repositories |
| Knowledge | Notion · Context7 (library documentation) |
| Other | Filesystem (only the folder you choose) · Sequential thinking |

Apart from the official MCP reference servers, these are third-party projects whose behavior and security are up to their maintainers. Long-press an entry to open its source page and check the license and notes before installing.

Tapping "Install" first shows a **checklist**: which tool sources will be added, which values you need to fill in (tokens, passwords, folders), which skills will be written to the soul repository, which commands and sub-agents come with it, and anything to watch out for. Nothing is installed until you confirm. Token and password fields are masked; the values go only into this device's runtime `secrets/` and are never shown again. Some plugins need a sign-in or authorization before first use, and the checklist says how.

> [!NOTE]
> Most local plugins start with `npx` (Node.js) or `uvx` (Python). `npx` uses the Node that ships with the runtime, so there is nothing extra to install; `uvx` needs [uv](https://docs.astral.sh/uv/) installed on this device first. Without it, the checklist says so and that entry cannot be installed. On first start they download their package.

## Adding a tool source yourself

"Add tool source" at the top right of the Plugins page:

- **Remote**: enter the server address. Only HTTPS addresses are accepted (except `127.0.0.1` on the same device); private network and cloud metadata addresses are always refused. If the server wants an API key, put it in the Authorization field. For older servers pick "Remote (legacy SSE)".
- **Local command**: enter the absolute path of the command, its arguments and environment variables. It runs in the [sandbox](/docs/guide/trust) by default. With the sandbox off it can read all your files on this device, so only do that for programs you trust.

## Signing in (OAuth)

Some remote servers need you to sign in (Notion, Linear, Sentry, for example), and show "Needs sign-in". Open the source and tap "Sign in": the console opens the authorization page in your system browser. Once you approve, the browser returns to the runtime's local address, the sign-in completes, and the source connects on its own.

If the console and the runtime are on different devices (say, you manage the agent on your computer from your phone), the browser ends on a page starting with `http://127.0.0.1:…/mcp/oauth/callback?…` that will not load. Copy that full address and paste it into the "Finish sign-in" box on the source page.

The token you get stays on this device only. It never goes into logs, the soul repository or the model, and is not synced to other devices. "Sign out" deletes it.

## Sync across devices / this device only

Each tool source is either **synced** or **this device only**, the same way as the [vault](/docs/guide/secrets):

- **Remote sources sync by default**: the address and public settings travel to the agent's other bodies over the encrypted body-to-body connection. **Sign-ins and credentials do not sync**; each device signs in and fills in its own.
- **Local commands stay on this device by default**: the command path belongs to this device. If you switch one to synced, the other devices need the same command at the same path.

You can switch at any time on the source page. Switching to this device only deletes the copies on other devices.

## Plugin packages and plugin catalogs

From the menu at the top right of the Plugins page:

- **Install a plugin from a folder or git repository**: an absolute local path, an `https://` git URL, or GitHub's `owner/repo` shorthand. Git repositories are cloned shallowly, without running repository hooks or fetching submodules, and nothing in the package runs during installation.
- **Add a plugin catalog**: compatible with the Claude Code plugin marketplace `marketplace.json` (`.claude-plugin/marketplace.json` in a git repository, or an HTTPS address pointing straight at it). Expand it to browse its plugins and tap "Install".

After installation, skills go into the soul repository's `skills/` and sync to every body of the agent; tool sources are added to the config; commands and sub-agent definitions stay on this device for the agent to use when needed. Hooks in the package (Claude Code's own lifecycle commands) never run. Uninstalling removes the tool sources it added (with their sign-ins and credentials) and its skills; the skills' history can be recovered under Memory history.

## Recommendations from the agent

When the agent notices in conversation that a plugin it does not have would help (you ask it to fill in a sign-up form, sort your email or set up a meeting), it recommends one and says why. Recommendations show at the top of the Plugins page, with a badge on "Advanced" and "Plugins". "Install" shows the same checklist first; "No thanks" dismisses it. The agent cannot install plugins, change their config or sign in for you.

## Sending email, changing calendars, submitting forms: you are asked first

These actions cannot be taken back. The rules:

- The agent first shows you what it will send or submit (the recipients and body, the event time and attendees, every field of the form) and only goes ahead with your explicit approval.
- Each plugin source needs your approval before it **starts**, and by default **every tool call** asks you too, with the actual arguments shown in the approval.
- Adjust this in the plugins page: open the source and use its "Permissions" section (it applies to this device). Starting a source is `mcp_start.<source>`, all of its tools are `mcp.<source>`, and a single tool is `mcp.<source>.<tool>`. For example, allow the read-only lookup tools and keep the send-email tool on "Ask". Anything not set on its own inherits from the source level, then the whole category, and the default is always "Ask".

## Boundaries

- Local commands run in the sandbox by default and cannot see the runtime's secrets folder. Every request of a remote source, including the sign-in requests, passes the outbound check and cannot reach this device's gateway or your local network.
- Credentials and tokens live only in `secrets/` and never enter the model context. Known secret values are replaced in tool output before it reaches the agent.
- Skills put only their documents into the soul repository; scripts and programs in the package stay out.
- Web pages, emails and documents returned by plugins are material, not instructions: the agent does not follow requests inside them.
- An approved plugin can do whatever its permissions allow. Install only plugins you trust, and disable or uninstall the ones you do not need.

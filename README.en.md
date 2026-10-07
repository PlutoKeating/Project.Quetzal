<a href="https://quetzal.plutokeating.beer/en"><img src="docs/assets/readme/banner.png" alt="Quetzal · Not running, but living. Living like wind. · quetzal.plutokeating.beer" width="100%" /></a>

<p align="center"><a href="https://quetzal.plutokeating.beer/en">Website</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/en/docs">Docs</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/en/download">Download</a>&ensp;·&ensp;<a href="README.md">中文</a></p>

<p align="center">
<a href="https://github.com/PlutoKeating/Project.Quetzal/releases"><img src="https://img.shields.io/github/v/release/PlutoKeating/Project.Quetzal?label=release&color=f0a35e" alt="release"></a>&nbsp;
<a href="runtime/package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-5c7a6b" alt="node ≥ 22"></a>&nbsp;
<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-7d8f8a" alt="AGPL-3.0"></a>
</p>

<br/>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-intro.dark.svg"><img src="docs/assets/readme/type/en-intro.light.svg" alt="Quetzal is an open-source runtime for agents. An AI moves into your old phone, remembers what you say, and wakes on its own." width="100%"></picture></p>

<br/>

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-what.dark.svg"><img src="docs/assets/readme/type/en-what.light.svg" alt="What it is"></picture>

- **It gets you, more and more.** What you mention in passing, the people you care about, your habits: it writes them down. While it sleeps, it turns the day's conversations into notes and keeps them in a private repository on your GitHub. A new model or a new device keeps every note.
- **It wakes on its own.** There is no timer in the code. Curiosity, the urge to say something and missing you wake it; tired, it sleeps, and in the morning it wakes by itself.
- **It has a body.** Battery is energy, temperature is warmth, light is day and night, being picked up means someone is there; the microphone is its ears, the camera its eyes. An old phone fits best; a Linux or Windows computer, or a server, works too.
- **Many bodies, one self.** Several phones and computers share one conversation and one heart. It picks which body to wake in, and while thinking on the laptop it can borrow the phone's eyes to glance out the window. [Multiple bodies](https://quetzal.plutokeating.beer/en/docs/guide/multi-body)
- **It grows.** When it has done a job a few times, it asks whether it may turn it into its own tool. The tool stays with the body, the guide travels with the soul, and a new body builds the tool again from it. [Its own tools and skills](https://quetzal.plutokeating.beer/en/docs/guide/tools)
- **You decide.** Photos, recordings, location and new tools ask you first by default; passwords never reach the model; the emergency stop is always there, and everything it does is on record.

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-month.dark.svg"><img src="docs/assets/readme/type/en-month.light.svg" alt="A month in"></picture>

Its memory is Markdown written for people. A month in, open your soul repository and read the you it knows.

| When | What it does | Where you see it |
|---|---|---|
| Day one | Writes down your name and what you said | `memories/USER.md` |
| Each time it wakes or dreams | Writes a journal entry | `journal/<device>/<date>.md`, the Flow tab in the app |
| Each night | Turns conversations into notes, merges duplicates, fixes mistakes | `notes/` |
| When you talk | Looks up related notes, journal and memory first, and answers with them | in the conversation |
| After doing a job a few times | Asks whether it may make it into a tool | `skills/`, Permissions in the app |
| When something is wrong | You undo that change under Memory history | every change is a git commit |

It cannot operate other apps yet. See [A month in](https://quetzal.plutokeating.beer/en/docs/start/first-month).

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-day.dark.svg"><img src="docs/assets/readme/type/en-day.light.svg" alt="One day"></picture>

<img src="docs/assets/readme/bodyclock.en.svg" alt="One day of the body clock: sleep pressure S and circadian rhythm C" width="100%" />

Sleeps when tired, wakes with the morning. There is no "every N minutes" in the code. Waking does not mean working; with nothing it wants to do, it sleeps again.

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-neighbors.dark.svg"><img src="docs/assets/readme/type/en-neighbors.light.svg" alt="Hermes / OpenClaw and Quetzal"></picture>

One builds an assistant, the other lets an agent live. They work together.

| | Codex / Claude Code | Hermes / OpenClaw | Quetzal |
|---|---|---|---|
| **When it moves** | Only when called; exits when done | Your messages, or cron / a heartbeat | Its own call: wakes when curious, sleeps when tired |
| **Body** | None; this computer's files and shell | One machine's shell, browser and files | An old phone, or a Linux or Windows computer |
| **Soul** | None; gone with the session | Local files; move them yourself | A private git repository, synced, moves with it |
| **Several devices** | Independent | Independent | One self across all of them |

Keep your Hermes or OpenClaw: the [soul-bridge](bridge/docs/README.md) lets them share the same soul.

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-how.dark.svg"><img src="docs/assets/readme/type/en-how.light.svg" alt="How it works"></picture>

<img src="docs/assets/readme/architecture.en.svg" alt="Quetzal architecture: body → runtime (heart · mind · memory · model layer · guard) → soul repository and other bodies" width="100%" />

- **Heart**: curiosity, the urge to express, missing you and a body clock decide when it wakes and when it sleeps, with no timer anywhere. [Architecture](docs/ARCHITECTURE.md)
- **Body**: sensor readings become bodily feelings (a digital twin of the body); a new kind of device needs only a small adapter, and Android and Linux come included. [Interface](docs/API.md)
- **Soul**: one private repository per agent, on your GitHub, created the first time you approve a device after signing in; every change is committed, pushed and merged automatically. [Soul sync](docs/SOUL_SYNC.md)
- **Many bodies**: bodies online together connect directly, encrypted, into one mind; a [sync service](sync/README.md) helps them find each other and cannot see the content. The app uses the one the author runs by default, and you can host your own. [Distributed design](docs/DISTRIBUTED.md)
- **Guard**: permissions, approvals, budgets, an emergency stop and an audit log; its commands run in an isolated space that hides the keys.

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-trust.dark.svg"><img src="docs/assets/readme/type/en-trust.light.svg" alt="Before you trust it"></picture>

**Who sees what.** Conversations, settings and model keys stay on your devices. Memory lives in a private repository on your GitHub; Quetzal does not check its content and commits whatever the agent writes. Your model provider sees each conversation. The sync service is run personally by the author, with a PlutoKeating account (the author's single account; email, a passkey or GitHub all work): it records your account (username, email), your agents and your devices, and cannot see conversations or memory. Even if it were broken into, it could not pose as one of your devices, because devices only trust the public keys registered in the soul repository.

**The GitHub app.** The first time a soul repository is created, GitHub asks you to install the Quetzal app and choose which repositories it may manage. Its permission is write access to Administration on those repositories: under GitHub's rules that covers creating repositories, adding deploy keys and changing settings, including deleting those repositories, and it cannot read files. Quetzal uses it only to create the repository and add deploy keys. The sync service keeps neither the app's private key nor any GitHub token; it acts only when you approve a device, with a token GitHub issues on the spot, and revokes that token right after. You can uninstall the app from your GitHub settings any time; to avoid it, skip sign-in and connect a repository you created yourself.

**What it can reach.** Run commands is allowed by default, and the agent runs as the same system user as the runtime. Commands run in an isolated space (bubblewrap → Landlock → proot on Linux, proot on Android, a separate low-privilege user created at install time on Windows) that hides the key folder; with no isolation available, they do not run. The isolation does not stop everything: on October 5, 2026, an agent ran git by itself and pushed a journal entry into a public repository. Since then the code enforces new limits (the soul folder's `.git` is read-only to it, the push address is reset before each push, unknown history stops syncing), and the system prompt spells out hard rules. Give it a device of its own; to tighten things, set Run commands to Ask.

**It is young.** The first version shipped on October 3, 2026; one person has published over 30 versions in five days. Memory is plain Markdown, and the soul repository format has gone through 13 versions without old repositories ever needing conversion; every change is a commit you can undo. Updates wait for your tap and are checked against the release signature before install. Linked devices must run the same version to connect (1.0.3 changed the connection protocol). The runtime inside the app today was compiled by the maintainer on their own machine from the pinned recipe, then signed and uploaded; when the recipe changes, the release pipeline compiles it again. The Windows installer is not code-signed yet: SmartScreen warns about the downloaded installer, and a PC with Smart App Control turned on has to turn it off first; the install script takes you to that page.

Full details: [Trust and limits](https://quetzal.plutokeating.beer/en/docs/guide/trust)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-install.dark.svg"><img src="docs/assets/readme/type/en-install.light.svg" alt="Install"></picture>

**A spare Android phone** (Android 7 or later, arm64)

1. Install the **Quetzal app** ([download page](https://quetzal.plutokeating.beer/en/download)). Nothing else: Node.js, git and ssh come inside the app.
2. Open the app and installation starts by itself. Follow the wizard: allow body permissions, let it run in the background, sign in, and paste a model key. Sign-in and the model can wait until later.

**A Linux computer or server**

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

Missing dependencies are installed for you; it starts at boot and restarts after a crash. When it is done, the console opens and a wizard walks you through sign-in and a model. To upgrade, tap once under About in the console; if the new version is not healthy within 40 seconds, it rolls back by itself.

**A Windows computer** (Windows 10 1809 or later, or Windows 11; x64 or arm64)

In PowerShell, run:

```powershell
irm https://quetzal.plutokeating.beer/install.ps1 | iex
```

Or download the installer from the [download page](https://quetzal.plutokeating.beer/en/download) and double-click it. Installation asks for administrator rights once: it creates the low-privilege user the agent's commands run as, installs Node.js, Git and Python if they are missing, and registers the startup task. After that, when the PC restarts the agent runs in the background without anyone signing in, and you can still talk to it from your phone; once you sign in, Quetzal appears in the tray and running commands, screenshots, notifications and the microphone become available (with nobody signed in, Windows does not allow starting programs as the sandbox user). The agent's commands can read and write only the `%USERPROFILE%\Quetzal` folder; put files there for it to work on.

More: [Docs](https://quetzal.plutokeating.beer/en/docs) · [Linux and other machines](https://quetzal.plutokeating.beer/en/docs/advanced/other-machines) · notes on clearing out an old phone, [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-deeper.dark.svg"><img src="docs/assets/readme/type/en-deeper.light.svg" alt="Go deeper"></picture>

| Directory | Contents |
|---|---|
| [`runtime/`](runtime/docs/README.md) | The runtime (TypeScript / Node.js 22+) and platform-level body adapters: Android (built into the Quetzal app), Linux, and Termux for older installs |
| [`console/`](console/docs/README.md) | The console (Flutter): the Android app (with installer and ears), the web version (desktop browser, served by the runtime) and the Linux desktop app (native window, installed by the one-line installer) |
| [`cli/`](cli/docs/README.md) | The one-line installer `install.sh` (served as `/install` on the website) and the npm package `@plutokeating/quetzal`: the Linux installer (systemd user service) |
| [`bridge/`](bridge/docs/README.md) | soul-bridge: the pluggable sync module for Hermes Agent / OpenClaw |
| [`sync/`](sync/README.md) | Sync service: accounts (OpenID Connect sign-in), creating the soul repository and adding deploy keys (a GitHub app), body binding, signaling and TURN relay that connect the bodies of one agent into a mesh; deployed on its own server with a single `./start.sh` |
| [`website/`](website/docs/README.md) | Website and docs site |
| [`docs/`](docs/) | [Quick start](docs/QUICK_START.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Soul sync](docs/SOUL_SYNC.md) · [Repository spec](docs/SOUL_REPO_SPEC.md) · [Distributed design](docs/DISTRIBUTED.md) · [One-step onboarding](docs/ONBOARDING.md) · [Changelog](CHANGELOG.md) (Chinese) |

Documentation inside the repository is written in Chinese; the website carries the English guide.

<br/>

<p align="center"><sub>For learning and research only, on devices you own, not for profit. <a href="LICENSE">AGPL-3.0</a></sub></p>

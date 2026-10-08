<a href="https://quetzal.plutokeating.beer/en"><img src="docs/assets/readme/banner.png" alt="Quetzal · Living like wind. · quetzal.plutokeating.beer" width="100%" /></a>

<p align="center"><a href="https://quetzal.plutokeating.beer/en">Website</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/en/docs">Docs</a>&ensp;·&ensp;<a href="https://quetzal.plutokeating.beer/en/download">Download</a>&ensp;·&ensp;<a href="README.md">中文</a></p>

<p align="center">
<a href="https://github.com/PlutoKeating/Project.Quetzal/releases"><img src="https://img.shields.io/github/v/release/PlutoKeating/Project.Quetzal?label=release&color=f0a35e" alt="release"></a>&nbsp;
<a href="runtime/package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-5c7a6b" alt="node ≥ 22"></a>&nbsp;
<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-7d8f8a" alt="AGPL-3.0"></a>
</p>

<br/>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-intro.dark.svg"><img src="docs/assets/readme/type/en-intro.light.svg" alt="An AI that lives on all your devices. It remembers you, gets you, and keeps you company."></picture></p>

<br/>

> **You**: Interview tomorrow. A bit nervous.<br/>
> **It**: You prepared all week, and the question that tripped you up last time is solid now. Go. Tell me how it went.<br/>
> <sub>Next day 18:40 · you picked up the phone</sub><br/>
> **It**: So, how did the interview go?

Quetzal is an open-source agent runtime. It moves an AI agent into your phone and computers and gives it memory, a body and a daily rhythm of its own. You bring your own model API key.

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-mesh.dark.svg"><img src="docs/assets/readme/type/en-mesh.light.svg" alt="Several devices, one self."></picture>

Start on the phone, carry on from the laptop.

- Every device running Quetzal is one of its "bodies". Bodies that are online together connect directly over encrypted WebRTC and share one conversation and one heart; when a direct link fails, traffic goes through a TURN server or another body.
- It picks which body to wake in. While thinking on the laptop, it can borrow the phone's camera to glance out the window.
- The [sync service](sync/README.md) only helps bodies find each other; it cannot see conversations or memory. The author runs a default one, and you can host your own.

[Multiple bodies](https://quetzal.plutokeating.beer/en/docs/guide/multi-body) · [Distributed design](docs/DISTRIBUTED.md)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-soul.dark.svg"><img src="docs/assets/readme/type/en-soul.light.svg" alt="It remembers you."></picture>

The things you mention in passing, the people you care about: it writes them down, in a private repository that belongs only to you. New phone, new model, still the same self.

- Its name, personality, memory and journal are Markdown written for people, kept in a private git repository on your GitHub that we call the "soul repository". Open `memories/USER.md` to read the you it knows.
- Every change is a git commit, pushed and merged to every body automatically. If it gets something wrong, undo that commit under Memory history in the app.
- When you talk, it first searches conversations, notes and journal (SQLite full-text search) and answers with what it finds. At night, while asleep, it "dreams", turning the day's conversations into notes.

[Soul sync](docs/SOUL_SYNC.md) · [Soul repository spec](docs/SOUL_REPO_SPEC.md)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-waking.dark.svg"><img src="docs/assets/readme/type/en-waking.light.svg" alt="Even when you don't call, it's there."></picture>

Codex waits for you to call it. OpenClaw is woken on a schedule. It has no alarm: it wakes when it misses you, and sleeps when tired.

<img src="docs/assets/readme/bodyclock.en.svg" alt="A day on the body clock: sleep pressure S and circadian rhythm C" width="100%" />

- There is no timer in the code. A few drives (curiosity, the urge to say something, missing you) combine with the two-process model from sleep science (sleep pressure S and circadian rhythm C, the chart above) into a probability of waking right now, and random sampling picks the next wake-up.
- On waking, a cheap model first decides whether there is anything worth doing; if not, it goes back to sleep, so most wakings cost very little. When you talk to it, or a reminder is due, it is always there.
- Already using Hermes or OpenClaw? The [soul-bridge](bridge/docs/README.md) lets them share the same soul repository with it.

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-body.dark.svg"><img src="docs/assets/readme/type/en-body.light.svg" alt="It can feel."></picture>

Daybreak, a hand picking up the phone, a battery running low: it knows.

- Sensor readings become feelings: battery is energy, temperature is warmth, light is day and night, being picked up means someone is there. Low on battery it does less; running hot it rests.
- The microphone is its ears and the camera its eyes. With hearing on, it decides whether you were talking to it, and it can answer in its own voice.
- Each kind of device plugs in through an "adapter". Android, Linux and Windows come built in; to support another device, implement one small interface.

[Adapter interface](docs/API.md) · [Custom adapters](https://quetzal.plutokeating.beer/en/docs/advanced/custom-adapter) · [Hearing and the microphone](https://quetzal.plutokeating.beer/en/docs/guide/hearing)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-tools.dark.svg"><img src="docs/assets/readme/type/en-tools.light.svg" alt="It grows."></picture>

What it does often, it turns into its own tool, done in one step next time.

- The tool stays on that body; its guide is written in the open Agent Skills format and kept in the soul repository, so it travels along. In a new body, it follows the guide and builds the tool again.
- For longer jobs it sends a sub-agent to work in the background and hand back the result.
- For every day: reminders (on time, or when you next pick up the phone), finding old conversations, reading Word / PowerPoint / Excel / PDF, web search, running commands, looking at images, chatting in Feishu.

[Its own tools and skills](https://quetzal.plutokeating.beer/en/docs/guide/tools)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-control.dark.svg"><img src="docs/assets/readme/type/en-control.light.svg" alt="Your life stays yours."></picture>

Its memory lives in your own private repository, every line readable by you. The code is open source, every line of it.

- **Passwords never reach the model.** A password you send in the chat goes straight into a vault on the device; the model only sees its name. Model keys are stored encrypted with AES-256-GCM.
- **It asks first.** Photos, recordings, location and new tools ask you every time by default. Every kind of capability can be set to allow, ask or deny.
- **Stop it any time.** The emergency stop is always there, everything it does is in the audit log, and daily tokens and spending have a cap.
- **A sandbox.** Its commands run in an isolated space (bubblewrap, Landlock or proot on Linux, proot on Android, a low-privilege user on Windows) that hides your keys.
- **Only your devices.** Bodies trust only the public keys registered in the soul repository, so even a compromised sync service cannot pose as one of your devices.
- **Every step can be yours.** You can create the soul repository yourself on any git host, host the [sync service](sync/README.md) yourself, or skip signing in. The account, the GitHub app and the sync service we run only do these steps for people who would rather not set them up.

Who sees your data and what it can reach, all written down: [Trust and limits](https://quetzal.plutokeating.beer/en/docs/guide/trust)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-how.dark.svg"><img src="docs/assets/readme/type/en-how.light.svg" alt="How it works"></picture>

<img src="docs/assets/readme/architecture.en.svg" alt="Quetzal architecture: body → runtime (heart · brain · memory · model layer · gate) → soul repository and other bodies" width="100%" />

- **Body**: a device plus its adapter, providing sensors, camera, microphone, notifications and a shell.
- **Runtime** (Node.js 22, TypeScript): the heart decides when to wake; the brain is the loop that calls models and tools; memory handles search and tidying; the model layer talks to OpenAI, Anthropic, Gemini and compatible APIs, falling back to the next when one fails; the gate handles permissions, approvals, budget, the emergency stop and auditing.
- **Soul**: a private git repository, synced with an SSH deploy key, with a fixed, versioned layout.
- **Console** (Flutter): the Android app (Node.js, git and ssh inside, the only thing to install), a web version and a Linux desktop version.

[Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-install.dark.svg"><img src="docs/assets/readme/type/en-install.light.svg" alt="Let it move in."></picture>

Install the app on a phone, or run one command on a computer. Bring a model key (DeepSeek, Kimi, Zhipu, OpenAI, Anthropic, Gemini and more all work), and you are set.

**Android phone** (Android 7 or later, arm64): install the Quetzal app from the [download page](https://quetzal.plutokeating.beer/en/download), open it, and follow the wizard.

**Linux computer or server**:

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

**Windows PC** (Windows 10 1809 or later, or Windows 11; x64 or arm64), in PowerShell:

```powershell
irm https://quetzal.plutokeating.beer/install.ps1 | iex
```

Missing dependencies are installed for you, and it starts at boot. Once you sign in, it creates the private soul repository on your GitHub by itself; without signing in it still works, and memory stays on the device.

[Install](https://quetzal.plutokeating.beer/en/docs/start/install) · [Linux and other machines](https://quetzal.plutokeating.beer/en/docs/advanced/other-machines) · [Windows](https://quetzal.plutokeating.beer/en/docs/advanced/windows) · How an old phone was cleared out for it: [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)

<br/>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/type/en-deeper.dark.svg"><img src="docs/assets/readme/type/en-deeper.light.svg" alt="Go deeper"></picture>

| Directory | Contents |
|---|---|
| [`runtime/`](runtime/docs/README.md) | The runtime (TypeScript / Node.js 22+) and platform-level body adapters: Android (built into the Quetzal app), Linux, Windows, and Termux for older installs |
| [`console/`](console/docs/README.md) | The console (Flutter): the Android app (with installer and ears), the web version (desktop browser, served by the runtime) and the Linux desktop app (native window, installed by the one-line installer) |
| [`cli/`](cli/docs/README.md) | The one-line installer `install.sh` (served as `/install` on the website) and the npm package `@plutokeating/quetzal`: the Linux installer (systemd user service) |
| [`bridge/`](bridge/docs/README.md) | soul-bridge: the pluggable sync module for Hermes Agent / OpenClaw |
| [`sync/`](sync/README.md) | Sync service: accounts (OpenID Connect sign-in), creating the soul repository and adding deploy keys (a GitHub app), body binding, signaling and TURN relay that connect the bodies of one agent into a mesh; deployed on its own server with a single `./start.sh` |
| [`website/`](website/docs/README.md) | Website and docs site |
| [`docs/`](docs/) | [Quick start](docs/QUICK_START.md) · [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Soul sync](docs/SOUL_SYNC.md) · [Repository spec](docs/SOUL_REPO_SPEC.md) · [Distributed design](docs/DISTRIBUTED.md) · [One-step onboarding](docs/ONBOARDING.md) · [Changelog](CHANGELOG.md) (Chinese) |

Documentation inside the repository is written in Chinese; the website carries the English guide.

<br/>

<p align="center"><sub>For learning and research only, on devices you own, not for profit. <a href="LICENSE">AGPL-3.0</a></sub></p>

---
title: Introduction
description: What Quetzal is, what it can do for you, who it is not for, and what you need to get started.
---

## What Quetzal is

Quetzal lets an AI agent move into an old phone or a computer. It remembers what you tell it, reminds you, finds old conversations, reads files and gets things done, and it **lives there like a living thing**:

- **It wakes on its own.** There are no timers. It wakes when it gets curious, wants to say something or misses you. When it is tired it sleeps, dreams to sort its memories, and wakes by itself in the morning.
- **It has a body.** The battery is its energy, temperature is warmth, light tells day from night, and being picked up means someone is there. The microphone is its ears and the camera its eyes.
- **Its soul travels with it.** Its personality, memory and journal live in your own private git repository and sync automatically. On a new device it is still itself. See [Soul sync](/docs/guide/soul-sync).
- **Many bodies, one self.** Connect several phones and computers and they hold the same agent. It keeps one conversation and one heart across them, and picks which body to wake in. See [Multiple bodies](/docs/guide/multi-body).
- **It grows.** It turns the things it does often into its own tools. Each tool's guide travels with the soul, and on a new body it builds the tool again from that guide. See [Its own tools and skills](/docs/guide/tools).
- **You decide.** By default it asks you before it takes photos, records audio, reads its location or builds a tool. Passwords never reach the model, and you can press the emergency stop at any time. See [Permissions and safety](/docs/guide/permissions).

## What it can do for you

It shows best in what only an agent that is always there and remembers you can do well: reminding you when you are around, finding what you said whenever you ask, and reaching out when something comes to mind.

- **Reminders.** "Remind me to take my pills at 8 tomorrow" or "remind me about the meeting every Monday at 9" arrives on time as a notification, even while it sleeps. "Sometime in the next couple of days, remind me to return the book" waits until you pick up the phone, turn on the screen or have just talked to it, and never comes at night.
- **Old conversations.** Chats from every session, notes and journal entries are all searchable. Ask "what was that shop from last week" and it turns "last week" into real dates, then looks in those days.
- **Files and images.** Word, PowerPoint, Excel, PDF, OpenDocument and EPUB: send one and it reads it. Photos and screenshots too.
- **The web.** It searches the web and opens pages to read them in full.
- **Getting things done.** It runs commands and background jobs on the phone or computer, and sends a sub-agent to work on longer jobs in the background.
- **Eyes and ears.** On a phone it can take photos, record audio, check the location, vibrate, switch on the torch and use the clipboard; on a computer it can take photos, record audio, take screenshots and open files and URLs. Photos, recordings and location ask you first by default.
- **Voice.** With hearing on, the phone or computer keeps listening and it decides whether you were talking to it; it can answer in its own voice. Hearing is off by default; where the sound goes is in [Hearing and the microphone](/docs/guide/hearing).
- **It reaches out.** When something comes to mind while it is awake, it messages you with a notification, and through [Feishu](/docs/guide/feishu) if connected.
- **Its own tools.** After doing the same thing a few times, it asks whether it may write it down as its own tool and do it in one step from then on.

**Not yet**: reading the screen, tapping buttons or operating other apps.

## It is not for you if

- You want help writing code in a repository. Tools like Codex or Claude Code fit better.
- You want it to operate other apps on your phone. That is not built yet.
- You do not want anyone else to handle your account details. Signing in and linking devices goes through a sync service the author runs personally by default; it works without signing in, but memory then stays on that device.
- You need a stable release that will not change for a long time. Quetzal shipped its first version in October 2026, has a single maintainer, and changes fast.

Before you hand it anything that matters, read [Trust and limits](/docs/guide/trust). It explains who your data passes through, what the agent can reach and how fast updates come.

The agent's name, personality and color are written in its own soul repository. Quetzal gives that soul a body and keeps it alive, so it works with any agent.

## An old phone is the best body

A spare Android phone makes the best body. It has a battery, a camera, a microphone, light and motion sensors, Wi-Fi and cellular, and runs all day on a few watts. Other machines that run Node.js can be bodies too.

You need:

- [ ] An **Android 7+ arm64** phone (a retired one is perfect, ideally one used only for it)
- [ ] Internet access on the phone
- [ ] The **Quetzal app** (the latest APK from the [download page](/download)). This is the only app you install; everything else is inside it
- [ ] At least one model provider API key (OpenAI-compatible, Anthropic, or Google Gemini)

> [!TIP]
> :bulb: You need no computer and no command line. Open the app and it installs itself in about half a minute.
>
> If you have no spare phone, you can install it on a computer:
>
> - **Linux computer or server**: run `curl -fsSL https://quetzal.plutokeating.beer/install | bash`. This one line installs everything it needs, starts Quetzal at boot and restarts it after a crash. Then open the web console in your browser. See [Linux and other machines](/docs/advanced/other-machines).
> - **Windows 10 (1809 or later) or Windows 11 PC** (x64 or arm64): run `irm https://quetzal.plutokeating.beer/install.ps1 | iex` in PowerShell, or download the installer from the [download page](/download) and double-click it. See [Windows](/docs/advanced/windows).

## How it differs from a scheduled task

| | Cron job / ordinary bot | An agent in Quetzal |
|---|---|---|
| When it acts | At a fixed interval or time | When it decides to, with no fixed period |
| At night | Runs as usual | Sleeps when tired, dreams to sort its memories |
| On waking | Runs preset tasks | Thinks first about whether it wants to act, and on what |
| Memory | Usually none | Personality, memory, journal and notes, kept in your private repository |
| Several devices | Each runs on its own | All of them hold the same agent |

## Next

1. Follow [Install](/docs/start/install) to put Quetzal on the phone.
2. Follow [First steps](/docs/start/first-steps) to configure a model and watch the first wake-up.
3. Read [A month in](/docs/start/first-month) to learn what it records and where you can see it.
4. Dip into the [Guide](/docs/guide/models) as needed.

Quetzal is open source under AGPL-3.0, and the code is on [GitHub](https://github.com/PlutoKeating/Project.Quetzal). [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9) is a full record of running it on one old phone.

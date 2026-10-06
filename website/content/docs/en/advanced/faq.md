---
title: FAQ
description: Common questions about cost, privacy, safety, updates, what it can and cannot do, several devices, and where your data lives.
---

## Will it spend money all the time?

No. It only calls a model when it wakes, and the first thing it does on waking is ask a cheap model whether it wants to act; if not, it goes back to sleep. Set daily token and cost caps under **Control → Advanced → Budget**; at the cap it wakes on its own one twentieth as often as before, and talking to it is not affected.

## Will it bother me at night?

It has a body clock: when sleepiness crosses the threshold it sleeps, and while asleep it only occasionally dreams to consolidate memory and sends no messages. Light affects it: bright light at night makes it more alert.

## Are my API keys safe?

Keys are encrypted with AES-256-GCM on the phone, the UI shows only the last four characters, and they never enter the soul repository or sync to other bodies.

## Can it see the passwords I send?

Not in plaintext. When it needs a credential it starts a **secret input**: what you send never enters the conversation or the model context; it goes straight into the local vault and it only gets a file path. See [Passing secrets](/docs/guide/secrets).

## What can it do?

Built-in tools: memory and notes, recall, web search and fetch, viewing images, reading documents (Word / PowerPoint / Excel / PDF and more), running commands and background jobs, listing processes, speaking (Azure Speech), proactive messages, sharing a thought, bounded changes to its own personality parameters, rewriting its personality, building its own tools, starting subagents. Plus the tools the device provides: on a phone, photos, audio recording, location, vibration, torch, clipboard and sensors; on a computer, photos, audio recording, screenshots, clipboard, and opening files and URLs.

It has no timed reminders or calendar. For what it will be like after a month of use, see [A month in](/docs/start/first-month).

## Can it do damage?

It can run commands, and **Run commands** is set to allow by default. Commands run in a sandbox and cannot see keys. This sandbox does not stop everything, and an agent really did get out of bounds once. Give it a device of its own; to tighten things, set **Run commands** to **Ask**. See [Trust and limits](/docs/guide/trust).

## Can it operate the phone screen and other apps?

**Not yet.** The `hands` interface (see the screen, tap, type, open apps) is reserved but no adapter implements it. Its permission defaults to "ask".

## Can I use it without a computer?

Yes. Installation, configuration and daily use all happen in the Quetzal app, with no command line at all: install that one app and open it, and it installs itself.

## I only have a computer, no spare phone. Does that work?

Yes. On a Linux computer or server, `curl -fsSL https://quetzal.plutokeating.beer/install | bash` installs everything in one line (missing dependencies included; it starts at boot, restarts after a crash and appears in your app list) and the web console opens in your browser, logged in without a pairing code (same machine); configuration and conversations all happen there. See [Linux and other machines](/docs/advanced/other-machines). That body just has fewer senses than a phone (no camera, light or motion sensors) and no ears (hearing lives in the phone app).

## Do I have to use Feishu?

No. The app is a complete console on its own. Feishu is an optional second entry point.

## Do I need a soul repository?

No. Signing in with GitHub creates a private soul repository under your account automatically; if you skip sign-in, identity, personality and memory stay on the device. When you want it to change devices, live on several, or have a memory history you can inspect and revert, sign in, or connect a repository you created yourself under **Control → Advanced → Sync**.

## Where is my data?

- **Your devices**: configuration, encrypted keys, the database (timeline, conversations, activity log, usage), the soul directory and the vault.
- **Your private soul repository on GitHub**: personality, memory, journal, notes, tool guides.
- **The model provider you chose**: the content of every conversation and of every wake-up where it thinks.
- **The sync service**: run by the author personally, and used by default for sign-in and for connecting your devices. It registers your GitHub username, agents and devices, and cannot see conversations or memory. The GitHub app you install at sign-in can manage the repositories you chose; the sync service uses it only at the moment you approve a device.

For what each of them can do and how to take it back, see [Trust and limits](/docs/guide/trust).

## Updates come so often. Will it lose its memory?

Its memory is Markdown files in your repository. The format has changed 12 times, and no old repository has needed converting; every change is a commit you can revert. You confirm each update. Watch out for two things: your devices must run the same version to connect, and conversation history lives only on the device, so uninstalling the app deletes it. See [Trust and limits](/docs/guide/trust#how-fast-updates-come).

## Can I run two agents at once?

Yes. Each runtime has its own home directory and port, and the app keeps several connections. See [Multiple agents](/docs/guide/multi-agent).

## Which phones are supported?

Android 7 or newer, arm64; all it needs is the Quetzal app. The older the phone, the more attention keep-alive needs (battery whitelist, autostart permission). Ideally, use a phone it has all to itself.

## What if it does something wrong?

- The **emergency stop** in the top bar freezes everything at once;
- **Control → Advanced → Activity log** shows what it did;
- a bad memory edit can be reverted from **Control → Advanced → Memory history** (a reverse commit; history is kept);
- to prevent a class of actions in future, set that category to ask or deny under **Control → Permissions**.

## License? :scroll:

Quetzal is open source under AGPL-3.0, for learning and research. Code and releases are on [GitHub](https://github.com/PlutoKeating/Project.Quetzal).

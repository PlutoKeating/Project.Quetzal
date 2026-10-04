---
title: FAQ
description: Common questions about cost, privacy, what she can and cannot do, several devices, and where your data lives.
---

## Will she spend money all the time?

No. She only calls a model when she wakes; the wake rate is set by drives and alertness, and the first thing she does on waking is a cheap introspection check — if she does not feel like doing anything she goes back to sleep. Set daily token and cost caps under **Control → Budget**; once spent she goes very quiet.

## Will she bother me at night?

She has a body clock: when sleepiness crosses the threshold she sleeps, and while asleep she only occasionally dreams to consolidate memory and sends no messages. Light affects her: bright light at night makes her more alert.

## Are my API keys safe?

Keys are encrypted with AES-256-GCM on the phone, the UI shows only the last four characters, and they never enter the soul repository or sync to other bodies.

## Can she see the passwords I send?

Not in plaintext. When she needs a credential she starts a **secret input**: what you send never enters the conversation or the model context; it goes straight into the local vault and she only gets a file path. See [Passing secrets](/docs/guide/secrets).

## What can she do?

Built-in tools: memory and notes, recall, web search and fetch, viewing images, reading documents (Word / PowerPoint / Excel / PDF and more), running commands and background jobs, listing processes, speaking (Azure Speech), proactive messages, sharing a thought, bounded changes to her own personality parameters, rewriting her personality. Plus whatever the body adapter provides: on a phone, photos, audio recording, location, vibration, torch, clipboard and sensors.

## Can she operate the phone screen and other apps?

**Not yet.** The `hands` interface (see the screen, tap, type, open apps) is reserved but no adapter implements it. Its permission defaults to "ask".

## Can I use it without a computer?

Yes. Installation, configuration and daily use all happen in the Quetzal app; the one command-line moment is pasting a single line into Termux to allow external apps.

## I only have a computer, no spare phone. Does that work?

Yes. On a Linux computer or server, `npx @plutokeating/quetzal` installs everything in one line and the web console opens in your browser, logged in without a pairing code (same machine); configuration and conversations all happen there. See [Linux and other machines](/docs/advanced/other-machines). That body just has fewer senses than a phone (no camera, light or motion sensors) and no ears (hearing lives in the phone app).

## Do I have to use Feishu?

No. The app is a complete console on its own. Feishu is an optional second entry point.

## Do I need a soul repository?

No. Without one, identity, personality and memory live in the local soul directory on the phone. Connect one when you want her to change bodies, live in several, or have a memory history you can inspect and revert.

## Where is my data?

All on the phone under `QUETZAL_HOME` (default `~/quetzal`): configuration, encrypted keys, the SQLite database (timeline, conversations, audit, usage), the soul directory and the vault. With a soul repository connected, **only personality and memory** are pushed to your own private repository. Quetzal has no cloud service of any kind.

## Can I run two agents at once?

Yes. Each runtime has its own home directory and port, and the app keeps several connections. See [Multiple agents](/docs/guide/multi-agent).

## Which phones are supported?

Android 7 or newer, arm64, able to install the Termux trio. The older the phone, the more attention keep-alive needs (battery whitelist, autostart permission).

## What if she does something wrong?

- The **emergency stop** in the top bar freezes everything at once;
- **Control → Audit log** shows what she did;
- a bad memory edit can be reverted from **Memory history** (a reverse commit; history is kept);
- to prevent a class of actions in future, set that category to ask or deny under **Permissions**.

## License? :scroll:

Quetzal is open source under AGPL-3.0, for learning and research. Code and releases are on [GitHub](https://github.com/PlutoKeating/Project.Quetzal).

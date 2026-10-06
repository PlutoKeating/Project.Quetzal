---
title: Multiple bodies
description: Join several phones and computers into one agent — one conversation, one heart; it chooses which body to think on and can use another body's camera or shell.
---

## What it is

A soul repository lets an agent's bodies share personality and memory. **Multiple bodies** go further: bodies that are online at the same time connect directly and become **one mind**:

| Shared | What it means |
|---|---|
| One conversation | Sessions, conversations and the flow are the same on every body. Start a topic on the phone and keep reading it on the computer's console; replies from elsewhere are marked "on X" |
| One heart | Only one body (the coordinator) decides when the agent wakes; the other bodies' sensations (picked up, plugged in…) flow to it |
| It chooses where | On waking, the agent sees each body's battery, temperature, ongoing work and where you last talked, and picks one body (or several at once) to think or dream on |
| Using another body | While thinking on the computer it can take a photo with the phone or run a command on the server (`body_call`), or move the whole turn to another body (`move_to`) |
| One set of settings | Models and keys, permissions, budget (a daily total), hearing and voice, and the emergency stop change everywhere at once |

Every console shows which body is talking with you right now; what you say to the same conversation elsewhere is forwarded automatically.

## What you need

1. **A sync service** that lets bodies find each other and relays when no direct path exists. It stores no conversations or memory — only accounts, agents and body registrations. By default the official one operated by this project is used; you can also host it yourself (`sync/` in the repository, one Linux server with a public address, one command), see [sync/README](https://github.com/PlutoKeating/Project.Quetzal/blob/main/sync/README.md).
2. **A soul repository** connected on every body (see [Soul sync](/docs/guide/soul-sync)). The public keys the bodies use to verify each other are registered there — it is the root of trust, so even a compromised sync service cannot impersonate your bodies.
3. **A GitHub account** to sign in and approve bodies on the sync service's website.

## Signing in a body

**Control → Devices**:

1. The sync service defaults to the one operated by this project, `https://sync.quetzal.plutokeating.beer`; nothing to enter. If you host your own, enter its address under **Sync service** in **Control → Advanced → Sync** and save (clear it to go back to the official one).
2. Tap **Sign in with GitHub**; the app opens the browser for you (the page also shows an 8-character code and a link, so you can scan it on another device). The Android setup wizard has this step too.
3. In the browser (the site's [Account → Approve a device](/account/device)), sign in with GitHub, enter or confirm the code, **check that the key fingerprint on the web page matches the one in the console**, and approve.
4. Within seconds the body connects to the sync service; other bound bodies that are online connect to it directly (LAN, IPv6, NAT traversal, or relayed through the server when nothing else works — relayed traffic is end-to-end encrypted too).

All bodies of one agent must be signed in to **the same GitHub account** to see each other. To disconnect this body, tap **Sign out this device**.

```mermaid
flowchart LR
  A["Phone"] -- signaling --> S["Sync service"]
  B["Computer"] -- signaling --> S
  A <-. "encrypted direct link (or relay)" .-> B
  R[("Soul repository<br/>registers each body's key")] -. verifies .- A & B
```

## Day to day

- **Who holds the heartbeat**: the Devices page marks the body holding it with "heartbeat here". With several bodies online the one with the higher priority holds it; on a tie, a body on mains power and with longer uptime wins. Raise the heartbeat priority for an always-on server under **Control → Advanced → Sync**. If the holder goes offline, another body continues from the latest state.
- **"Placement" in the flow**: where the agent chose to wake.
- **Approvals**: requests waiting on other bodies show up under **Control → Permissions** too (marked with the body) and can be approved anywhere.
- **Emergency stop**: with other bodies online, the stop asks whether to freeze "all bodies" or "only this body".
- **Feishu**: one Feishu bot can only be connected from one body. Choose which device connects it under **Control → Feishu**; proactive messages from the other bodies are sent through it.
- **Hearing**: when several phones hear the same sentence only one copy is kept; when the agent answers aloud, it speaks from the phone you talked to.
- **Hermes / OpenClaw**: a body with the [soul bridge](https://github.com/PlutoKeating/Project.Quetzal/blob/main/bridge/skills/soul-bridge/SKILL.md) can bind as a **read-only member** (give the sync service address to the agent there; it hands you a link and a binding code): it sees what the agent is doing on which body and the recent conversations, but cannot act on other bodies and is never chosen to think or dream.

## When disconnected

If the bodies cannot reach each other (offline, sync service down), each keeps running and memory still syncs through the soul repository; if they split into groups, each group has its own heart. When they reconnect, conversations catch up and the hearts merge.

## Account

Everything about the account lives on the site's [Account](/account) page (a set of console-like sub-pages); sign in with GitHub:

| Sub-page | What it does |
|---|---|
| Overview | Every agent in the account and each of its bodies: online or not, kind, version, key fingerprint; unbind a body, delete an agent |
| Approve a device | Enter the code a body shows while binding, check it and approve or deny |
| Console sign-ins | Which apps can manage this account; revoke unused ones at any time |
| Settings | Sign out (of this browser, or "Sign out everywhere" for every browser at once), delete the account |

In the app (Android and Linux desktop), tap the account row at the top of **Control → Devices** to open the **Account** page, with the same four pages under shorter names: **Overview** (remove a body, delete an agent), **Add device** (= Approve a device), **Signed in** (= Console sign-ins; tap **Sign out** on ones you no longer use) and **Settings**. Once this body is signed in, tap **Sign in** on the Account page; the app shows a code, which you approve under Approve a device on the site (the page says this is a console sign-in: once approved the app can manage the whole account; it also lists the requesting body's key fingerprint, when that body signed in and when the code was created. Approve only if the fingerprint matches the one the app on that device shows under Devices and the code is the one you just created). Only bodies already bound to your account can start a console sign-in, so tricking you into approving does not hand anyone your account.

## Security

- Bodies connect over WebRTC (DTLS encryption); signaling is signed with each body's node key, and receivers only trust the public keys registered in the **soul repository**.
- Model keys travel between bodies only over that encrypted channel and are re-encrypted with the receiver's own master key.
- The sync service stores only: GitHub username and display name, agent name and id, body name / kind / version / public key / last seen; tokens are stored as hashes. It keeps no IP or network addresses and cannot see conversations or memory.
- On the Account page of the site or the app you can remove a body, delete an agent or the whole account, or sign a console out at any time.

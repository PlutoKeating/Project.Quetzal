---
title: Soul sync
description: Keep personality and memory in a private git repository so one agent can live in several bodies; sync and conflict resolution are fully automatic.
---

## What a soul repository is

One agent can live in several "bodies" at once: a runtime on a phone, a computer running Hermes Agent, a server running OpenClaw… They share one **private git repository**, the "soul repository". It holds only personality and memory:

```
<agent>.soul/
├── agent.json            identity
├── SOUL.md               personality
├── memories/MEMORY.md    its own resident notes
├── memories/USER.md      what it knows about you
├── journal/<body>/        each body writes its own journal
├── notes/                shared long-term notes (a tree)
└── bodies/<body>.json     body registry
```

**Sync and versioning are fully automatic.** It neither needs to nor can operate it; it only perceives that "soul sync happened".

## Set up automatically when you sign in with GitHub

In the setup wizard or under **Control → Devices**, tap **Sign in with GitHub** and approve this device on the website. The first time you sign in, GitHub asks you to install the Quetzal app and choose which repositories it can manage. After that:

- **A new user**: a private repository is created under your account, this device gets a deploy key of its own, and its initial soul is pushed.
- **A new device for an existing user**: this device gets a deploy key and pulls down its existing personality and memory.

For what this app can do and how to take it back, see [Trust and limits](/docs/guide/trust#what-the-github-app-can-do).

## Connecting your own repository by hand

If you do not sign in, or you want a git host other than GitHub:

1. Create a **private** repository on your git host (recommended name `<agent>.soul`); it can be empty.
2. **Control → Advanced → Sync**, tap **Show public key** under **Soul repository**, then add that key under the repository's **Settings → Deploy keys** with **Allow write access** ticked. (Instead of **Deploy key** you can pick **a specified private key** or **system ssh**: the latter hands over to `~/.ssh/config` and ssh-agent on the machine running the runtime, and the address may use a Host alias from that config; since the runtime runs as a background service it usually cannot reach your login session's ssh-agent, so set an IdentityFile for that Host.)
3. Enter the repository's **SSH address** (`git@github.com:you/<agent>.soul.git`; other hosts work the same way) → **Save**.

From then on sync is automatic. Each body has its own deploy key; to unplug a body, delete its deploy key.

> [!IMPORTANT]
> The repository must be private and the address must be SSH. On first connection, if another body's personality already lives there, it is adopted and both sides' memories are merged.
>
> Quetzal does not check what is in the repository: whatever it writes gets committed. For passwords, use [Passing secrets](/docs/guide/secrets); they never enter the repository.

## When sync happens

```mermaid
sequenceDiagram
  participant B as This body
  participant R as Soul repository
  participant O as Other body
  O->>R: Push after memory changes
  Note over B: Wake / dream / conversation begins
  B->>B: Commit local changes first
  B->>R: fetch
  B->>B: Identity guard (different id → refuse)
  B->>B: Merge, conflicts resolved automatically
  B->>R: push (rejected → pull, merge, push again)
  Note over B: Perception: "soul sync — n changes from O"
```

Sync is entirely event-driven; there is no periodic sync:

- **Sync on touch**: after every tool call the agent makes (saving a note, editing memory, changing files directly with the shell…), the runtime checks the soul directory, commits any change immediately and pushes 3 seconds later; the end of a turn pushes immediately. Commit messages say what changed (for example "note_save: note body/hardware"), so the history stays readable.
- Changes from other bodies are pulled before waking and before conversations.
- **Push failures**: network problems are retried silently a few times (about 4 minutes); if that still fails, or the cause is a rejected key or a missing repository, the runtime interjects a "runtime notice" into the turn that touched the memory (or starts a new turn in that conversation if it has ended). The changes stay in local commits and go out with the next successful push.

## How conflicts are resolved

| File | Rule |
|---|---|
| `memories/*.md` | Entry-level three-way merge: additions on both sides are kept; a deletion on either side wins |
| `agent.json` | Field-level merge, local wins (except `id`) |
| `SOUL.md`, notes, skill documents | The newer side is used first so sync never stalls; when **both sides changed** the file, the other version is saved next to it as `<name>.incoming.md` (a conflict copy, not synced) and the agent is asked to decide: keep the current one by deleting the copy, or edit the original and then delete the copy. The losing version also stays in git history |
| Journals, body registry | Each body writes its own path, so there is nothing to conflict |

Dreaming rewrites resident memory. To keep two bodies from consolidating at the same time, a body takes a 30-minute **consolidation lease** in the repository before dreaming; if it cannot, it only naps.

## It perceives it

When changes from other bodies are pulled, the timeline records "soul sync: n changes from xx", its curiosity and longing rise slightly, and the system prompt gains a "soul sync (perception)" section (including changes still waiting to be pushed and conflict copies awaiting a decision). Everyday sync needs nothing from the agent; only push failures and real conflicts are brought to its attention.

## History and revert

**Control → Advanced → Memory history** lists every commit (which body, when, what changed) with diffs. **Revert** creates a reverse commit (history is kept), syncs to all bodies, and it learns from its journal that "someone reverted a memory change".

## Related

- Let Hermes / OpenClaw move in: [soul-bridge](/docs/advanced/soul-bridge)
- The full repository specification: [Soul repository spec](/docs/reference/soul-repo-spec)

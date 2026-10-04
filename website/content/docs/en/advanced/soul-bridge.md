---
title: soul-bridge
description: Make a machine running Hermes Agent or OpenClaw another body of the same agent: send one message to the agent there and it installs itself.
---

## What it is

**soul-bridge** is a small, independent, pluggable daemon installed on a machine running [Hermes Agent](https://hermes-agent.nousresearch.com/) or OpenClaw. It syncs that framework's personality and memory files with the soul repository in **both directions**: the one on the phone and the one on the computer are the same soul.

```mermaid
flowchart LR
  R[("Soul repository<br/>GitHub Private")]
  subgraph Phone["Phone: runtime"]
    RT["built-in sync"]
  end
  subgraph PC["Computer: Hermes Agent"]
    BH["soul-bridge"] <--> HF["~/.hermes/SOUL.md<br/>memories/*.md"]
  end
  subgraph Server["Server: OpenClaw"]
    BO["soul-bridge"] <--> OF["workspace/SOUL.md<br/>MEMORY.md · USER.md<br/>memory/*.md · notes/"]
  end
  RT <-- "SSH deploy key" --> R
  BH <-- git --> R
  BO <-- git --> R
```

## Installing: let it install itself

Step 3 of **Control → Soul sync** has a ready-made message. Copy it and send it to the Hermes or OpenClaw agent on that machine. Following the skill, it will:

1. check for and install Node.js (22.18+) in the user directory, fetch the program and keep the skill in its own skills directory;
2. determine the soul repository: the address you gave → its own memory → an existing `*.soul` private repository on GitHub → create one;
3. run one `init` that does everything: generate a deploy key, add it with write access when `gh` or `GITHUB_TOKEN` is available, clone, import the existing personality and memory, install hooks and the background service, sync once;
4. run `doctor` and fix what it suggests.

Only when GitHub credentials are missing, git is missing with no sudo, or the same error fails three times does it send you one consolidated message, usually just **adding the deploy public key once on the GitHub website**.

> [!TIP]
> You never need to open a terminal.

## What is synced

| Mapping | Hermes | OpenClaw |
|---|---|---|
| Personality | `SOUL.md` | `SOUL.md` |
| Resident notes | `memories/MEMORY.md` (truncated to Hermes's character limit on write-back; the truncation is not written to the repository) | `MEMORY.md` (free Markdown; new paragraphs are absorbed as entries) |
| About the user | `memories/USER.md` | `USER.md` |
| Journal | — (Hermes has no journal) | `memory/YYYY-MM-DD*.md` both ways; other bodies' journals mirrored to `memory/bodies/<body>/` |
| Shared notes | — | `memory/notes/**.md` per file, both ways |
| Takes effect | Next session | Next turn |

The bridge **copies** files and remembers a baseline on both sides: additions in the framework are kept, deletions are honoured, and entries cut by a character limit stay in the soul instead of being mistaken for deletions.

## When it syncs

Hermes: after memory tool calls, at session end, on file changes, plus periodic pulls. OpenClaw: on start, `/new`, `/reset`, after compaction, on file changes, plus periodic pulls. The periodic pull is only a transport detail (that machine cannot receive push notifications) and has nothing to do with the agent's waking.

## Commands (for troubleshooting)

| Command | Purpose |
|---|---|
| `init` | Connect in one command |
| `doctor` | Self-check with fix suggestions |
| `sync` | Sync once now |
| `status` | Configuration, last sync result, public key |
| `attach` / `detach [--purge]` | Reinstall hooks and service / unplug (framework files are left as they are) |

Local data lives in `~/.agent-soul/<agent>/`: configuration, repository copy, baseline, deploy key, log.

## Unplugging

Have the agent there run `detach`, or simply delete its deploy key on GitHub: it can no longer write to the soul repository, and the framework's files stay as they are.

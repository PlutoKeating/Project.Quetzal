---
title: Soul repository spec
description: A summary of the soul repository specification (v4) — directory tree, file formats, merge rules, commit conventions and authentication.
---

## Scope

This page summarizes the [Soul Repository Specification v4](https://github.com/PlutoKeating/Project.Windler/blob/main/docs/SOUL_REPO_SPEC.md). Every implementation that reads or writes a soul repository (the runtime, soul-bridge, and future ones) must follow it. The repository is the agent's own **private** repository and its contents are never inspected.

## Repository

- One agent, one repository, **private**; the recommended name is `<agent>.soul`.
- Only the `main` branch. History is append-only: **no** force push; undo is always a reverse commit.

## Directory tree

```
<agent>.soul/
├── .soul-spec.json            fixed     spec version
├── .gitattributes             fixed     line endings and text attributes
├── .gitignore                 fixed     ignore temporary files
├── README.md                  fixed     auto-generated, no personal content
├── agent.json                 required  identity
├── SOUL.md                    required  personality
├── memories/MEMORY.md         required  the agent's own resident notes
├── memories/USER.md           required  about the user
├── journal/<body>/<YYYY-MM-DD>[-<slug>].md   required  journal
├── notes/[<category>/…/]<topic>.md   required  shared notes, up to 4 levels
├── bodies/<body>.json         required  body registry
└── locks/consolidation.json   optional  consolidation lease
```

Extra top-level entries **may** appear (things she put there herself); implementations must not delete them. Missing fixed and required entries are **filled in automatically** on connection as one commit. UTF-8, LF, no file over 1 MiB, no binaries.

## File formats

| File | Key points |
|---|---|
| `agent.json` | `id` (UUID v4, never changes), `name` (`^[a-z0-9][a-z0-9-]{0,39}$`), `displayName`, `pronouns`, `description`, `color` (`#RRGGBB`), `language` (BCP 47), `createdAt`, optional `seed` |
| `SOUL.md` | Free Markdown; the first line should be `# <display name>` |
| `memories/*.md` | Entries separated by `\n§\n`, file ends with `\n`; **no character limit**; truncated when written to a framework with a limit, and the truncation is never written back |
| `journal/<body>/…` | First line `# <date> · <body>`, sections `## <HH:MM> <title>`, append-only; each body writes only its own directory |
| `notes/…` | First line `# <topic>`, optional `> ` summary line; path segments stripped of illegal characters, max 60 chars, max 4 levels; no index files committed |
| `bodies/<body>.json` | `{body, kind: runtime｜bridge, runtime/framework/bridge version, host?, lastSeen}`; **no** IP, MAC or serial numbers |
| `locks/consolidation.json` | `{body, until}`, valid 30 minutes; a successful push acquires it |

## Merge rules

| File | Rule |
|---|---|
| `memories/*.md` | Entry-level three-way merge: both sides' additions kept; a deletion on either side wins |
| `agent.json` | Field-level merge, local wins except `id`; a seed identity yields to the remote |
| `SOUL.md`, notes | The side with the newer commit wins; empty or seed local adopts the remote; the losing version stays in history |
| Journals, body registry | Each body writes its own path; no conflicts |

## Commit conventions

Author `<displayName> (<body>)`, email `<name>@<body>.local`; message `<description> (<body>)`. Pull and merge before pushing, retry on rejection, never force push.

## Content: not inspected (v4)

Implementations **must not** redact, privacy-check or otherwise inspect content, and must not refuse a commit because of content. Protection comes from access control, not inspection. Implementation-side configuration (keys, tokens, Feishu credentials, deploy private keys) lives in the implementation's own secrets directory, separate from the soul repository.

## Authentication: deploy private key only

- The remote address **must** be SSH (`git@host:owner/repo.git` or `ssh://git@host/owner/repo.git`); no HTTPS, personal tokens or passwords.
- **One dedicated ed25519 key per body**, generated locally, private key mode `0600`, never committed, never copied between bodies.
- The public key is added to that repository as a **deploy key with Allow write access**; personal SSH keys are not allowed.
- Remote access uses `ssh -i <key> -o IdentitiesOnly=yes` with no fallback to ssh-agent; if the key is missing, remote access is refused.
- To revoke a body, delete its deploy key.

## Version history

v4 removes all content checks and allows extra top-level entries; v3 clarified what counts as an IP address; v2 removed the resident-memory limit and made notes a tree; v1 was the first release. Older repositories need no migration.

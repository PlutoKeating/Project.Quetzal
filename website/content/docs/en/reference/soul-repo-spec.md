---
title: Soul repository spec
description: A summary of the soul repository specification (v12): directory tree, file formats, merge rules, commit conventions and authentication.
---

## Scope

This page summarizes the [Soul Repository Specification v12](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/SOUL_REPO_SPEC.md). Every implementation that reads or writes a soul repository (the runtime, soul-bridge, and future ones) must follow it. The repository is the agent's own **private** repository and its contents are never inspected.

## Repository

- One agent, one repository, **private**; the recommended name is `<agent>.soul`.
- Created by the deployer and holding only this one agent's soul; it **must not** be shared with any code repository (including the Quetzal source repository), must not contain program code, and its content must not be pushed anywhere else (v9).
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
| `bodies/<body>.json` | `{body, kind: runtime｜bridge, runtime/framework/bridge version, host?, meshKey?, lastSeen}`; `meshKey` is the body's node public key for the mesh (v8; other bodies verify it against this entry); `lastSeen` is updated when the content changes or after an hour; **no** IP, MAC or serial numbers |
| `locks/consolidation.json` | `{body, until}`, valid 30 minutes; a successful push acquires it |

## Merge rules

| File | Rule |
|---|---|
| `memories/*.md` | Entry-level three-way merge: both sides' additions kept; a deletion on either side wins |
| `agent.json` | Field-level merge, local wins except `id`; a seed identity yields to the remote |
| `SOUL.md`, notes, skill documents | The side with the newer commit wins; empty or seed local adopts the remote; the losing version stays in history; when both sides changed the file, it may also be saved as a `<name>.incoming.md` conflict copy (ignored by `.gitignore`, never synced) for the agent to decide, and readers and framework mappings must skip such copies (v8) |
| Journals, body registry | Each body writes its own path; no conflicts |

## Commit conventions

Author `<displayName> (<body>)`, email `<name>@<body>.local`; message `<description> (<body>)`; granularity is up to the implementation, down to one commit per change (v8). Pull and merge before pushing, retry on rejection, never force push.

## Content: not inspected (v4)

Implementations **must not** redact, privacy-check or otherwise inspect content, and must not refuse a commit because of content. Protection comes from access control, not inspection; there are no exceptions. Implementation-side configuration (keys, tokens, Feishu credentials, deploy private keys) lives in the implementation's own secrets directory, separate from the soul repository.

## Authentication: SSH only; a deploy key per body by default, your own key if you choose (v7)

- The remote address **must** be SSH (`git@host:owner/repo.git` or `ssh://git@host/owner/repo.git`; a Host alias from `~/.ssh/config` works too); no HTTPS, personal tokens or passwords.
- **Default: one dedicated ed25519 key per body**, generated locally, private key mode `0600`, never committed, never copied between bodies; its public key is added to that repository as a **deploy key with Allow write access**; remote access uses `ssh -i <key> -o IdentitiesOnly=yes` with no fallback to ssh-agent, and a missing key refuses remote access with a clear message. To revoke a body, delete its deploy key.
- **The deployer may explicitly switch to their own key**: a specified private key (still used exclusively), or the system ssh configuration (no `-i`; `~/.ssh/config` and ssh-agent decide). Selectable under **Soul repository** in the console's **Control → Advanced → Sync**.

## Only the soul repository's own history (v9)

Implementations must: reset `origin` to the configured address before every push; refuse to merge a remote that has no `agent.json` but has content outside the specification; record the soul repository's known root commits and stop syncing (with an alert) when an unknown root commit appears; block the agent's git commands aimed at the soul directory and say so in its guidance; and limit git's repository discovery (`GIT_CEILING_DIRECTORIES`). This comes from a real incident: after a failed push, an agent pointed its soul directory's remote at the program's public source repository, a soul commit ended up in the public repository, and the source history was later merged into the soul repository.

## Safe git execution (v10)

The soul directory may have been touched by the agent, so implementations treat everything in it as untrusted: git runs with hooks and fsmonitor disabled, without system or global config, and without the `file://` / `ext::` protocols; push and fetch use the configured address directly (not `origin`, so `url.*.insteadOf` has no effect), and keys outside an allowlist are removed from `.git/config` before each operation; symlinks are never committed, checked out as links or merged. Private key paths must be absolute and are shell-quoted in `GIT_SSH_COMMAND`.

## Version history

v12 accepts a history that a body created locally when it joined, as long as it contains only soul repository content, and no longer pushes such a local history; v11 drops the pre-commit secret check, so content is not inspected at all; v10 adds "safe git execution" (no code from the repository is run, addresses come only from configuration, no symlinks); v9 states that the soul repository is created by the deployer and unrelated to any code repository, and adds the five "own history only" implementation requirements; v8 adds conflict copies, the body registry's `meshKey`, and no longer requires `lastSeen` on every push; v7 adds the deployer-selectable "specified key" and "system ssh configuration" modes to authentication; v4 removes all content checks and allows extra top-level entries; v3 clarified what counts as an IP address; v2 removed the resident-memory limit and made notes a tree; v1 was the first release. Older repositories need no migration.

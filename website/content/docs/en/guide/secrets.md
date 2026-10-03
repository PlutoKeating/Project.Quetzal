---
title: Passing secrets
description: When she needs a password, token or key, you type it in the chat box; it never enters the conversation or the model context and goes straight into the vault.
---

## Why this exists

While working she often needs credentials: a GitHub token, a service password, a private key. If you sent them in chat, the plaintext would land in the conversation log, the model context and the provider's logs. So she does not ask that way. She calls `pass_secret` to start a **secret input**.

## The flow

```mermaid
sequenceDiagram
  participant A as She
  participant W as Runtime
  participant U as You (app / Feishu)
  A->>W: pass_secret(purpose, item names and hints)
  W->>U: Notice: each message is one value; done spell done-xxxxxx
  loop One item per message
    U->>W: value
    W-->>U: Receipt: item i/N received (character count only)
  end
  U->>W: Done spell (or tap "Done")
  W->>W: Write vault/<name> (mode 0600)
  W-->>A: name, path, byte count — no plaintext
```

- She first explains in her own words which items she needs and what each is.
- After that, **each message you send is one value**, matched in order. Only leading and trailing whitespace is trimmed; multi-line values (such as private keys) are kept as is.
- When finished, send the **done spell** (the app's "Done / Redo / Cancel" buttons are equivalent). `spell redo` clears and starts over; `spell cancel` abandons.
- **Ten minutes of silence abandons automatically**; abandoned values are discarded. Only the done spell writes anything to disk.

In the app, a banner sits above the input during secret input and the field is masked by default (tap the eye to reveal; multi-line values need to be revealed before pasting). In Feishu it is a card that updates with progress; afterwards **recall those messages yourself**.

## The vault

Stored in `WINDLER_HOME/vault/`, one file per item, named after the item. **Control → Vault** shows name, hint, source channel and time, and lets you delete — it **never shows contents**.

The vault belongs to this body only: it is **not synced to other bodies** and never enters the soul repository.

## How she uses it

She references values by path in commands (`"$(cat path)"` or `< path`) without printing them. Every tool's output is scrubbed before reaching the model: any secret value that appears becomes `‹secret:name›`.

> [!WARNING]
> This protects against **accidental** leaks (`cat`, `env`, debug output). She and the runtime are the same system user, so the vault is readable from her shell; "she cannot see the plaintext" is guaranteed by protocol, tool conventions and output scrubbing, not by OS-level isolation. If you do not want her near a credential, do not hand it over.

## It can be denied

"Request secrets" is its own permission category and can be set to ask or deny under **Control → Permissions**. She can only start a secret input inside a conversation; when she wakes alone the tool tells her to arrange a time with you first.

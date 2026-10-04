---
title: Upgrade and rollback
description: Installing a newer APK upgrades the runtime; a failed health check rolls back automatically; restart and reinstall from the Service page.
---

## Upgrading

The Quetzal app bundles the runtime. After installing a newer APK, the app notices its bundled version is newer than the running one and offers a **one-tap upgrade** on the home screen; you can also trigger it from **Control → Service → Upgrade / Reinstall**.

Upgrading runs the same idempotent script as installation:

```mermaid
flowchart TB
  A[Place new version in releases/<version>/] --> B[previous ← current<br/>current ← new version]
  B --> C[Restart service]
  C --> D{/health OK within 40 s?}
  D -- yes --> E[Keep only the last 3 versions]
  D -- no --> F[Switch back to previous and restart]
```

- Her memory, configuration, keys and vault live in the home directory, separate from version directories, so **upgrades leave them untouched**.
- After an upgrade she wakes again on the new version, as if after a nap.

> [!TIP]
> The app version equals the runtime version. The Service page shows the running version and the version bundled in the app.

## Automatic rollback

If the new version does not pass the health check within 40 seconds, the script points `current` back to the previous version, restarts, and reports the reason in the wizard. Nothing for you to do.

## Manual actions

**Control → Service**:

- **Restart**: the process exits and runit brings it back at once (asks for confirmation).
- **Upgrade / Reinstall**: re-runs the install script; use it to repair a broken installation.
- **Ignite**: when the runtime is offline, the app re-runs the boot script through Termux.

## Circuit breaker and safe mode

More than five starts within ten minutes is treated as repeated crashing: the runtime enters **safe mode**, keeping only the gateway and Feishu up, not waking and not calling models, and tells you. See [Troubleshooting](/docs/advanced/troubleshooting).

## Releases on GitHub

Every production release is published on GitHub Releases with release notes. The [download page](/download) reads the latest and past versions live.

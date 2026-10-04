---
title: Glossary
description: Terms that recur throughout the Quetzal documentation — runtime, body, adapter, heart, drives, soul repository, soul-bridge, guard, vault…
---

## Terms

| Term | Chinese | Meaning |
|---|---|---|
| runtime | 运行基座 | Quetzal's core program (single file `main.cjs`) that lets an agent live in a body |
| agent | agent | The "she / he / it" living in the runtime; identity comes from `agent.json` in the soul repository |
| body | 身体 | A device running a runtime (or soul-bridge); one agent may have several bodies |
| body adapter | 身体适配器 | The only boundary between device and core: sampling, notifications, playback, device tools |
| body twin | 身体数字孪生 | Physical samples mirrored into an internal model that derives energy, warmth, brightness, picked-up and other feelings |
| sense event | sense 事件 | A significant change in body state (plugged in, light, moved, hot…) that adjusts drives |
| heart | 心脏 | The module deciding when to wake: drives, body clock, wake sampling |
| drives | 内驱力 | Curiosity, expression, longing, open loops, each 0–1, saturating over time |
| body clock | 生物钟 | Two-process model of sleep pressure S and circadian rhythm C; sleepiness = S − C |
| wake rate (hazard) | 醒来率 | Instantaneous probability density of waking (per hour), from drives, alertness and inhibition |
| inhibition | 抑制 | Multiplicative factors on the wake rate: stop, pause, no model, heat, low battery, offline, budget spent |
| mind | 大脑 | Execution of one wake-up or conversation: introspect → tool loop → reflect (finish) |
| quick model | 内省模型 | A cheap model used on waking for the "do I feel like acting?" check |
| dream | 做梦 | A wake-up during sleep that consolidates memory (moving detail from resident memory into notes) |
| session | 会话 | A container for a conversation; processed in order within, in parallel across, visible to each other |
| steer / queue / interrupt | 插话 / 排队 / 打断 | Three ways a message is handled while she is working |
| idle wall | 时间墙 | No-progress timers: 90 s per model call, 120 s per session |
| soul | 灵魂 | The agent's personality and memory (`SOUL.md`, resident memory, journal, notes, identity) |
| soul directory | 灵魂目录 | Local `QUETZAL_HOME/soul/`, a git repository |
| soul repository | 灵魂仓库 | The private git repository shared by all bodies, `<agent>.soul` |
| soul sync | 灵魂同步 | Fully automatic pull, merge and push by the runtime; she only perceives it |
| soul-bridge | 灵魂桥 | The pluggable sync daemon installed on Hermes / OpenClaw machines |
| identity guard | 身份守卫 | Refuses to merge repositories whose `agent.json.id` differs |
| seed identity / seed soul | 种子身份 / 种子人格 | Auto-generated, unmodified identity and personality; yields to an existing remote |
| consolidation lease | 整理租约 | A 30-minute lock taken in the repository before dreaming, so two bodies do not consolidate at once |
| resident memory | 常驻记忆 | `memories/MEMORY.md` and `USER.md`, §-separated entries, unlimited |
| notes | 笔记 | Shared long-term notes in a tree up to 4 levels deep |
| journal | 日记 | Episodic memory, one file per body per day |
| memory index | 记忆目录 | The notes index placed in context (categories, counts, titles and summaries) |
| guard | 闸门 | Permissions (allow / ask / deny), approvals, budget, emergency stop, audit |
| permission category | 能力类别 | Network, commands, device, camera, microphone, location, proactive messages, self-adjust, rewrite memory, screen, request secrets |
| approval | 审批 | A request from an "ask" category; no answer in 30 minutes counts as denial |
| emergency stop | 急停 | The `STOP` file in the home directory; if present, everything freezes |
| audit | 审计 | Records of tool calls, configuration changes, memory edits and approval decisions |
| pass_secret | 保密传递 | The protocol for requesting credentials: you type in chat, nothing enters the conversation or context |
| vault | 保密库 | `QUETZAL_HOME/vault/`, local storage for secret values, never synced |
| done spell | 结束口令 | The random phrase `done-xxxxxx` marking the end of a secret input |
| gateway | 网关 | The runtime's local interface at `127.0.0.1:7788`: HTTP + WebSocket RPC |
| pairing code | 配对码 | Six digits, valid five minutes, for a console on another device to connect to the gateway; a browser on the same machine needs none (the gateway lets it in directly) |
| web console | 网页控制台 | The console as a web page, served by the runtime's gateway (`http://127.0.0.1:7788/`) and laid out for a wide screen; installed on Linux machines by the npm package |
| ignite | 点火 | The app re-running the boot script through Termux when the runtime is offline |
| safe mode | 安全模式 | Protective state after more than five starts in ten minutes: gateway and Feishu only |
| Now | 此刻 | The app's home page: state, drives, the thought she wants to share |
| Flow | 心流 | The app's timeline page: wake-ups, dreams, conversations |
| proactive message | 主动消息 | A message she sends with `send_message` when waking on her own |
| hands | hands | The reserved screen-and-apps interface (not yet implemented) |
| Termux trio | Termux 三件套 | Termux, Termux:API, Termux:Boot, all from the same source |
| home directory | 家目录 | `QUETZAL_HOME`, where all runtime data lives, default `~/quetzal` |

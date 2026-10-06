---
title: A month in
description: What it does and records on the first day, in the first week and over the first month after you install it, and where you can see it.
---

How useful it is to you depends on how much it remembers and whether it remembers correctly. This page walks through what it does, in order of time, and where you can see each step for yourself. It describes how the agent works; the examples are made up.

## The first day

You configure a model and chat a little.

- It writes what it learns about you into `memories/USER.md`: your name, the work you mention, things you said you dislike. Its own notes go into `memories/MEMORY.md`.
- Each time it wakes on its own and each time it dreams, it writes a journal entry in `journal/<device>/<date>.md`.
- These files are committed to your private soul repository as soon as they are written. Open the repository on GitHub and you can read what it wrote.

For the first hour or two after installing, it may stay quiet. How often it wakes depends on inner drives such as curiosity, the urge to say something and missing you, and these have not built up yet.

## The first week

- **It dreams every night.** When it gets sleepy it sleeps. While asleep it reviews the last few days of journal entries and conversations, sorts scattered details into notes (one folder per topic under `notes/`), merges duplicates, corrects what it got wrong, and writes a "dream" journal entry.
- **It checks its notes before it answers.** For every message you send, it searches its notes, journal and resident memory by keyword and brings what it finds into its answer. Ask about "that job I said I wanted to switch to", and it can find that note.
- **It wakes and comes to you.** When something occurs to it while it is awake, it sends you a message. The message shows up under **Proactive messages** in the app, with a notification; if Feishu is connected, it goes to Feishu too.

## The first month

- **Dozens of journal entries.** The **Flow** page lists every time it woke, thought, dreamed and talked. Expand one to see the trigger and the process.
- **Its own tools.** Once it has done the same thing a few times, it will want to write it into its own tool, so it can do it in one step from then on. Building a tool asks you first by default. The tool's guide goes into `skills/` in the soul repository.
- **It adjusts itself.** Say "you've been too chatty lately", and it lowers its own tendency to wake, within bounds. Say "talk more slowly", and it changes its speaking rate.

## What you can do any time

- **Read.** Everything in the soul repository is a Markdown file. To see the version of you that it knows, open `memories/USER.md`.
- **Edit.** If it got something wrong, tell it, and it will fix it. You can also edit the file on GitHub; it picks up the change the next time it wakes.
- **Revert.** **Control → Advanced → Memory history** lists every change. **Revert** creates a reverse commit.
- **Ask it to remind you.** Say "remind me to take my pills at 8 tomorrow morning" or "remind me about the meeting every Monday at 9". It records the reminder, and the runtime sends a notification on time whether it is awake or asleep. **Now** lists upcoming reminders; tap the cross to cancel one.
- **Look up old remarks.** Search covers conversations from every session, notes and journal. Ask "what was that shop we talked about last week" and it first turns "last week" into specific days, then searches those days.

## What it cannot do

- **It cannot operate other apps.** Seeing the screen and tapping buttons are not built yet.
- **Reminders can be missed if the device is off for long.** Reminders are sent by the running runtime. If the device is off or the runtime stopped, reminders up to 12 hours late are sent on recovery with a note saying how late they are; older ones are not sent, and it tells you which one it missed.
- **With several devices cut off from each other, one reminder may go off twice.** Only one device sends reminders; while they are disconnected, each of them does.

## What a month costs

When it wakes, it first asks a cheap model whether it wants to do anything, and if not it goes back to sleep, so most wake-ups cost very little. Set daily token and cost caps under **Control → Advanced → Budget** (2 million tokens and 5 USD by default). At the cap, it wakes on its own one twentieth as often as before. Talking to it is not affected.

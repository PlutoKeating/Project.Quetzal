---
title: A month in
description: What it does and records on the first day, in the first week and over the first month after you install it, and where you can see it.
---

How useful the agent is to you depends on how much it remembers and whether it remembers correctly. This page goes through what it does over time and where you can see each step for yourself. It describes how the agent works, and the examples are made up.

## The first day

You configure a model and chat a little.

- It writes what it learns about you into `memories/USER.md`: your name, the work you mention, things you said you dislike. Its own notes go into `memories/MEMORY.md`.
- Each time it wakes on its own and each time it dreams, it writes a journal entry in `journal/<device>/<date>.md`.
- These files are committed to your private soul repository as soon as they are written. Open the repository on GitHub and you can read what it wrote.

For the first hour or two after installing, it may stay quiet. How often it wakes depends on inner drives such as curiosity, wanting to say something and missing you, and these have not built up yet.

## The first week

- **It dreams every night.** When it gets sleepy it sleeps. While asleep it reviews the last few days of journal entries and conversations and sorts scattered details into notes, with one folder per topic under `notes/`. It merges duplicates, corrects what it got wrong, and writes a "dream" journal entry.
- **It checks its notes before it answers.** For every message you send, it searches its notes, journal and resident memory by keyword and uses what it finds in its answer. Ask about "that job I said I wanted to switch to", and it can find that note.
- **It wakes and comes to you.** When something occurs to it while it is awake, it sends you a message with a notification. If Feishu is connected, it goes to Feishu too. It decides which conversation the message goes in: an earlier conversation on the same topic, or a new one. Messages from the same wake stay together. Reminders go to the **Proactive messages** conversation.

## The first month

- **Dozens of journal entries.** The **Flow** page lists every time it woke, thought, dreamed and talked. Expand one to see the trigger and the process.
- **Its own tools.** Once it has done the same thing a few times, it will want to turn it into its own tool so it can do it in one step from then on. By default it asks you before it builds a tool. The tool's guide goes into `skills/` in the soul repository.
- **It adjusts itself.** Say "you've been too chatty lately", and it lowers its own tendency to wake, within set limits. Say "talk more slowly", and it slows its speaking rate.

## What you can do any time

- **Read.** Everything in the soul repository is a Markdown file. To see what it knows about you, open `memories/USER.md`.
- **Edit.** If it got something wrong, tell it, and it will fix it. You can also edit the file on GitHub; it picks up the change the next time it wakes.
- **Revert.** **Control → Advanced → Memory history** lists every change. **Revert** creates a new commit that undoes the change.
- **Ask it to remind you.** Say "remind me to take my pills at 8 tomorrow morning" or "remind me about the meeting every Monday at 9". It records the reminder, and the runtime sends a notification on time whether the agent is awake or asleep. For things that are not urgent, say "remind me to return the book sometime in the next two days". It waits until you are around (you pick up the phone, or have just messaged it), tells you why it chose that moment, and stays quiet at night. **Now** lists upcoming reminders; tap the cross to cancel one.
- **Find what you said before.** Search covers conversations from every session, its notes and its journal. Ask "what was that shop we talked about last week", and it first turns "last week" into specific days, then searches those days.

## What it cannot do

- **It cannot operate other apps.** It cannot yet see the screen or tap buttons.
- **Reminders can be missed if the device is off for a long time.** The runtime has to be running to send reminders. If the device was off or the runtime stopped, reminders up to 12 hours late are sent when it comes back, with a note saying how late they are. Older ones are not sent, and the agent tells you which ones it missed.
- **When several devices lose contact with each other, one reminder may go off twice.** Normally only one device sends reminders. While they are disconnected, each of them sends them.

## What a month costs

Most wake-ups cost very little. When it wakes, it first asks a cheap model whether it wants to do anything, and if not, it goes back to sleep. Set daily token and cost caps under **Control → Advanced → Budget** (2 million tokens and 5 USD by default). Once it reaches a cap, it wakes on its own one twentieth as often as before. You can still talk to it as usual.

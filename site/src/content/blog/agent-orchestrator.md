---
title: "My coding agents kept waiting on me, so I built an agent orchestrator"
description: "Why I built Glimmervoid: it runs Claude Code and Codex side by side, gives every agent its own git worktree, and tells you the moment one needs you."
pubDate: 2026-09-14
tags: ["glimmervoid", "agents", "claude-code"]
---

The agent that needed me was always in the terminal I wasn't looking at. I'd have Claude Code sessions going in four or five windows, each in a different repo, and one of them would stop to ask a yes-or-no question while I was reading another one's diff. By the time I found it, it had been idle long enough that I'd lost the thread of what I asked it to do.

Agents made me faster right up until I ran more than two of them. After that the bottleneck was me: noticing which one needed an answer, keeping their changes out of each other's way, and reviewing work I never watched happen. So on March 10 I started building Glimmervoid, an agent orchestrator, and six months and 1,039 commits later it's how I work every day.

<figure>
  <video src="../../capture/dashboard.webm" poster="../../capture/hero.webp" width="1440" height="900" controls muted loop playsinline preload="metadata" aria-label="The Glimmervoid dashboard replaying four recorded Claude Code sessions: one fixes a flaky upload test and commits, one stops for permission on a billing migration, two more finish small tasks."></video>
  <figcaption>The real dashboard replaying recorded Claude Code sessions: one agent in focus, three more working in the rail.</figcaption>
</figure>

## What an agent orchestrator does

An agent orchestrator sits one level above your coding agents. Claude Code and Codex are harnesses: each is the loop that turns a model into an agent that reads files, runs commands and edits code. Glimmervoid doesn't replace that loop, and it never sits between an agent and its model. It starts each agent as a real process in a real terminal, with your own login and settings, and then supervises all of them: where each one works, what state it's in, and what it produced.

It's a small Node.js process on your own machine with a browser dashboard in front of it. If an agent CLI runs in a terminal, you can declare it in the config and Glimmervoid will orchestrate it too.

## What it does today

**It knows which agent needs you.** Every session sits in a rail on the left, grouped by project, and the ones waiting on you collect in a "needs you" queue at the top. `Alt+J` jumps to the next one. Status comes from the agent's own lifecycle hooks, not from reading its screen, so when the rail turns amber, a session really is waiting. Getting that right took a full rewrite, which I wrote up in [its own post](https://www.johncwaters.com/blog/my-terminal-congratulated-me-for-clearing-the-screen/).

**Every agent gets its own worktree.** Each session in a git repo runs in its own git worktree, so five agents in one repo never trample each other or your checkout. A review sidebar shows what the selected agent has committed and what it hasn't, and merges its work back with one click while the agent keeps running. If the merge conflicts, one button hands the conflict back to the agent that wrote the code.

<figure>
  <img src="../../capture/hero.webp" alt="Glimmervoid focus view: session rail with complete, needs input and working states, a live Claude Code terminal, and the worktree review sidebar" width="1440" height="900" loading="lazy">
  <figcaption>The focus view: the session rail on the left, the selected agent's live terminal in the middle, and its worktree review on the right.</figcaption>
</figure>

**Agents can orchestrate too.** With the agent API switched on, a session can run `glimmervoid spawn` to start a sibling agent in its own worktree, `glimmervoid attention` to flag that it needs you, and `glimmervoid board` to read what every other session is doing. Spawning is fenced on purpose: at most three live children per session, and a child can't spawn children of its own.

**It follows you to your phone.** The phone layout is a separate design with its own board, terminal, and review screens, not the desktop squeezed down. You pair a phone once with a single-use link behind your own HTTPS proxy (I use Tailscale), and if no dashboard tab is open anywhere, Glimmervoid can ping you on Telegram instead.

**It finds work for you.** Radar polls PostHog error tracking and, when an issue spikes, regresses, or first appears, sends an agent to diagnose it. With auto-fix on, that agent repairs the bug in a throwaway worktree and hands back a pull request, and it can never push or merge on its own. Sessions that were live when Glimmervoid stopped come back on the next start with their conversations resumed.

## Where it's going

Supervising agents by hand is the first step. The agent API is the start of the next one: a software factory, where agents plan the work, hand pieces to other agents, and review what comes back, while the board shows you the whole line instead of one terminal at a time. The orchestrator's job stays the same at that scale. It owns where every agent runs, what state each one is in, and the one signal that means a person is needed.

Glimmervoid binds to localhost and needs no account. It runs on Windows and Linux, it's MIT licensed, and it's developed inside Glimmervoid, which is the best test suite I have.

<p class="button-line">The agent that needs me is no longer in the terminal I'm not looking at. It's the amber one.</p>

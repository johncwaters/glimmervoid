---
title: "My coding agents kept waiting on me, so I built them a control room"
description: "What Glimmervoid is: one dashboard with a live terminal for every coding agent, a git worktree each, and a signal the moment one needs you."
pubDate: 2026-09-14
tags: ["glimmervoid", "agents", "claude-code"]
---

The agent that needed me was always in the terminal I wasn't looking at. I'd have Claude Code sessions going in four or five windows, each in a different repo, and one of them would stop to ask a yes-or-no question while I was reading another one's diff. By the time I found it, it had been idle long enough that I'd lost the thread of what I asked it to do.

Agents made me faster right up until I ran more than two of them. After that the bottleneck was my attention, and the tools I had were built for one agent in one terminal. So on March 10 I started building Glimmervoid, a control room for coding agents, and six months and 1,039 commits later it's how I work every day.

<figure>
  <video src="../../capture/dashboard.webm" poster="../../capture/hero.webp" width="1440" height="900" controls muted loop playsinline preload="metadata" aria-label="The Glimmervoid dashboard replaying four recorded Claude Code sessions: one fixes a flaky upload test and commits, one stops for permission on a billing migration, two more finish small tasks."></video>
  <figcaption>The real dashboard replaying recorded Claude Code sessions: one agent in focus, three more working in the rail.</figcaption>
</figure>

## What it is

Glimmervoid is a small Node.js process that runs on your machine and spawns your coding agents in real terminals. It streams every session's live output to one browser dashboard and tells you, with a color and a notification, the moment a session is waiting on you, has finished, or has failed.

It's an orchestrator, not a harness. Claude Code and Codex are the harnesses, the loop that turns a model into an agent, and Glimmervoid runs them exactly as you would in your own terminal, with your own login and your own settings. It never sits between an agent and its model. If an agent CLI can run in a terminal, you can declare it in the config and watch it on the board.

## Four things it does that a row of terminals can't

**It knows which agent needs you.** Every session sits in a rail on the left, grouped by project, and the ones waiting on you collect in a "needs you" queue at the top. `Alt+J` jumps to the next one. Status comes from the agent's own lifecycle hooks, not from reading its screen, so when the rail turns amber, a session really is waiting. Getting that right took a full rewrite, which deserves [its own post](../deleting-the-screen-scraper/).

**Every agent gets its own worktree.** Each session in a git repo runs in its own git worktree, so five agents in one repo never trample each other or your checkout. A review sidebar shows what the selected agent has committed and what it hasn't, and merges its work back with one click while the agent keeps running. If the merge conflicts, one button hands the conflict back to the agent that wrote the code.

<figure>
  <img src="../../capture/hero.webp" alt="Glimmervoid focus view: session rail with complete, needs input and working states, a live Claude Code terminal, and the worktree review sidebar" width="1440" height="900" loading="lazy">
  <figcaption>The focus view: the session rail on the left, the selected agent's live terminal in the middle, and its worktree review on the right.</figcaption>
</figure>

**It follows you to your phone.** The phone layout is a separate design with its own board, terminal, and review screens, not the desktop squeezed down. You pair a phone once with a single-use link behind your own HTTPS proxy (I use Tailscale), and if no dashboard tab is open anywhere, Glimmervoid can ping you on Telegram instead.

**It brings you the work you'd otherwise go looking for.** Optional lanes watch things for you. Radar polls PostHog error tracking and, when an issue spikes, regresses, or first appears, sends an agent to diagnose it. With auto-fix on, that agent repairs the bug in a throwaway worktree and hands back a pull request, and it can never push or merge on its own. Sessions that were live when Glimmervoid stopped come back on the next start with their conversations resumed.

## Why not let one agent run the others

The strongest case against a tool like this is that agents are getting their own multi-agent features, and cloud platforms will run a fleet for you. Both of those own the loop, though, so you work inside one vendor's idea of how agents should be supervised, on their machines, with their limits. I want the opposite: the CLIs I already use, unmodified, on my own hardware and subscriptions, with switching between Claude Code and Codex costing me nothing. The thing I actually needed was never a smarter agent. It was a board I could trust enough to stop checking every terminal myself.

Glimmervoid binds to localhost and needs no account. It runs on Windows and Linux, it's MIT licensed, and it's developed inside Glimmervoid, which is the best test suite I have.

<p class="button-line">The agent that needs me is no longer in the terminal I'm not looking at. It's the amber one.</p>

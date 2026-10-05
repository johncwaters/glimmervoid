---
title: "I spent 11 weeks teaching my dashboard to read Claude Code's screen. Then I deleted it."
description: "How Glimmervoid tells which of a dozen coding agents needs you: 4,298 lines of screen scraping out, lifecycle hooks in, and the three bugs hooks still had."
pubDate: 2026-10-05
tags: ["glimmervoid", "claude-code", "agents", "debugging"]
---

At its peak, the status detector in my agent dashboard kept a hard-coded list of words that Claude Code prints while it thinks. <span class="chrome">Galloping</span> was on it, and so was <span class="chrome">Brewed for</span>. Each one was there because the detector had mistaken it for something else, usually a finished turn, and every new Claude Code release had a chance of adding another.

I run coding agents across ten projects at once, so I built [Glimmervoid](../control-room/): one browser dashboard with a live terminal for every session and a tap on the shoulder the moment one of them needs me. The terminals were the easy part, because node-pty, xterm.js and a WebSocket get you there in a weekend. The tap on the shoulder is the whole product, and it took me two tries.

## An agent never tells the terminal it's waiting for you

A coding agent CLI draws a prompt for a person to read. Nothing in the byte stream says "blocked on input" or "turn finished", and the screen is a full TUI that redraws itself constantly. So when I started the project on March 10 (it was called Glissa then), I did what almost everyone does first: I read the screen.

<div class="stack" aria-label="The screen scraping stack">
  <div class="stack-row gone"><span>3-layer prompt matcher: exact strings, regex, silence timer</span><span>deleted</span></div>
  <div class="stack-row gone"><span>ANSI tokenizer and line assembler</span><span>deleted</span></div>
  <div class="stack-row gone"><span>Blacklist of spinner words and HUD chrome</span><span>deleted</span></div>
  <div class="stack-row gone"><span>Idle, startup-grace and auto-recover timers</span><span>deleted</span></div>
  <div class="stack-row kept"><span>Terminal title spinner glyph</span><span>demoted</span></div>
</div>

The matcher had to rebuild screen lines out of cursor moves and carriage returns before it could match anything, then arm on a likely prompt and wait out a silence timer to confirm it. The commit log from those weeks reads like a war diary: `prevent prompt chrome from cancelling armed pattern matches` on March 22, `prevent OSC sequences from cancelling armed prompt matches` two days later, and `debounce pattern detection feed to reduce CPU` on April 3. Every fix was correct, and every fix made the next bug harder to find, because three overlapping mechanisms could each change a session's state and I often couldn't say which one had fired. I had no ground truth either, so I was tuning by anecdote.

## One commit, minus 4,298 lines

On May 29 I deleted the whole stack in a single commit.

<div class="diffstat" aria-label="Commit diffstat"><span class="meta">38 files</span><span class="add">+1,713</span><span class="del">&minus;4,298</span></div>

The replacement uses signals the agent emits on purpose. When Glimmervoid spawns a Claude Code session, it passes a settings file with HTTP hooks scoped to that one session, and those hooks POST to a localhost endpoint, guarded by a per-session token, on every lifecycle event: prompt submitted, turn stopped, notification raised, sub-agent started or finished. Nothing in the target repo changes. The terminal title survived as a fallback with a much smaller job, because it may only say working, ready or unknown. A spinner glyph can't know that an agent is waiting on a question, so the title source is never allowed to claim it.

## Hooks still had three surprises

<p class="incident"><strong><code>/clear</code> looked like a finished turn.</strong> It fires no prompt or stop hook, but the redraw flashes a spinner and then an idle glyph in the title, so the dashboard congratulated me every time I cleared the screen. Now a clear or compact resets both sources and mutes the title until the next real prompt.</p>

<p class="incident"><strong>Background sub-agents outlived the turn.</strong> The main agent's stop hook fires while a background agent is still working, which closed the card on live work. A completion gate now counts live sub-agents and orders racing signals by sequence number, because concurrent hooks routinely land in the same millisecond.</p>

<p class="incident"><strong>Auto-resume silently never ran.</strong> It captured the conversation id from <code>SessionStart</code>, which Claude Code doesn't reliably fire on interactive startup. It now takes the id from whichever main-agent hook arrives first.</p>

Each of these is now a recorded session, a JSONL file of hook payloads and state transitions, that a replay harness drives back through the detection code on every test run. That corpus is the ground truth I didn't have in March.

## Read what a program emits on purpose

The best argument for scraping is that it works on any CLI, while hooks tie you to whatever each vendor chooses to expose. I take that seriously, and it's why the title fallback exists: a custom agent declared in Glimmervoid's config gets status from its terminal title alone. When the title doesn't say, the dashboard shows unknown. A board that's confidently wrong once is a board you stop trusting, and once you stop trusting it you're back to alt-tabbing through terminal windows, which is the problem it was built to solve. Codex and Grok both have hooks now, and Glimmervoid uses them.

<figure>
  <img src="../../capture/hero.webp" alt="Glimmervoid focus view: session rail with complete, needs input and working states, a live Claude Code terminal, and the worktree review sidebar" width="1440" height="900" loading="lazy">
  <figcaption>The focus view today. Amber means a session is waiting on you, and it only ever lights up from a hook.</figcaption>
</figure>

Glimmervoid is at v0.29.0 after 1,240 commits, and I build it inside itself. Every session gets its own git worktree that you review and merge from the dashboard, there's a phone layout for checking in from the couch, and you can approve a Claude Code plan from either. It runs on Windows, macOS and Linux, binds to localhost, and needs no account.

<p class="button-line">Claude Code still says "Galloping" while it thinks. My dashboard has stopped having an opinion about it.</p>

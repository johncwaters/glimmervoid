# Measurement: server weight and runtime alternatives

Date: 2026-11-09
Build measured: `0.53.2-next.0`, `dist/server/index.js`, Linux x64, `/usr/bin/node` v22.23.2

Question: the server looks heavy (6 to 10% CPU, 230 to 390 MB RSS). Would another runtime fix it?

Answer: no. The weight is the usage scanner re-reading every transcript after each server start. Once
caught up, the live server sits at 0.54% CPU. No runtime tested changes the rescan.

## Live server profile

Inspector opened on the running server with `SIGUSR1`, driven over CDP for 120 s, then closed.
7 sessions (2 with a live PTY), about 20 minutes uptime.

- CPU: the JS thread was 94.4% idle. App time was the usage scanner: `scanFile` and `walkDir` in
  `server/usage/usage-scanner.ts`, plus the parsers they call, `parseCodexUsageLine`
  (`server/usage/core/usage-codex-core.ts`) and `parseJsonOrNull` (`server/core/json-core.ts`). The rest went to libuv
  file reads and the kernel (6.2 s system time in the window).
- Disk: 434 MB read, 846k block-input ops in 124 s.
- JS heap, 97 MB live: strings 35 MB, compiled code 18 MB, arrays 17 MB, retained script source about
  10 MB. Largest app store: the scanner's `primaryIndex` (7 MB) and `collisionIndex` (3.5 MB).
- GC: 269 minor and 24 incremental collections, 365 ms total. Not a factor.
- Handles: 179 `FSWatcher`, 4 `Server`, 3 `Socket`.
- After catch-up, 6.5 minutes of 10 s buckets: CPU averaged 0.54%, disk reads 0 MB.

Side effect to expect if repeating this: `HeapProfiler.takeHeapSnapshot` paused the process about 3 s
and left about 630 MB in the glibc `[heap]` mapping that was not returned. Only a restart reclaims it.

## Cause: full transcript rescan on every start

Fresh server with an isolated `GLIMMERVOID_HOME` and one dashboard socket connected (the scanner starts
only on a control connection, `server/backend/backend-lanes.ts`). Transcripts on the host: 10,633
`.jsonl` files, 6.8 GB under `~/.claude/projects` and `~/.codex`.

| Measure | Value |
|---|---|
| Bytes read until quiet | 5.2 GB |
| Wall time | 21 minutes |
| CPU | 136 s (about 11% average) |
| Peak RSS / heap | 364 MB / 196 MB |
| Settled RSS / heap | 199 MB / 72 MB |
| Same server, no dashboard connected | 119 MB read, then quiet |

Reads come in 64 MB slices (`DEFAULT_BYTE_BUDGET`) every 15 s (`PARTIAL_CONTINUE_MS`). Per-file
cursors live only in the in-memory `fileStates` map in `usage-scanner.ts`; the warehouse file keeps
daily rollups only. So every restart starts from offset 0 for every file, and `walkDir` applies no
mtime cutoff even though entries older than `retainDays` (90) are pruned after parsing.

Fix options, not yet specified:

1. Persist `fileStates` (path, size, mtimeMs, offset) beside `usage-warehouse.json` and load it at
   start, so a restart reads only appended bytes.
2. Skip files whose mtime predates the retention window during the walk.

## Runtime alternatives

Isolated server per runtime: temp `GLIMMERVOID_HOME`, `GLIMMERVOID_PORT`, telemetry off, no dashboard
connected. 5 s settle, 60 s idle, then 2000 sequential `GET /` with curl (curl-bound, so wall time does
not separate runtimes; CPU ticks do).

| Runtime | Idle RSS | Peak RSS | Idle CPU | CPU ticks, 2000 req | Notes |
|---|---|---|---|---|---|
| Node 22.23 | 135 MB | 176 MB | 1.06% | 240 | below `engines` `>=24.15.0` |
| Node 24.22 | 198 MB | 239 MB | 0.41% | 204 | about 60 MB more RSS; `node-pty` works |
| Bun 1.4.2 | 135 MB | 151 MB | 1.20% | 161 | no `node:sea`; needs a shim to boot, watcher child crash-loops |
| Node 22, `MALLOC_ARENA_MAX=2` | 128 MB | 172 MB | 0.73% | 240 | about equal |
| Node 22, jemalloc `LD_PRELOAD` | 184 MB | 244 MB | 0.75% | 247 | worse |
| Node 22, `--max-semi-space-size=2` | 140 MB | 162 MB | 0.76% | 232 | marginal |
| Node 22, `--lite-mode` | crashed | | | | `fetch` needs WebAssembly |

Idle RSS is mostly runtime and code: the JS heap is 30 to 40 MB of the 135 MB. Bun's gains are a
lower peak and about 33% less CPU per request, against a `node:sea` port (`server/runtime-paths.ts`,
`server/update-check.ts`) and untested full sessions. Deno was not installed; a Go or Rust rewrite was
not built, so neither was measured.

Other processes for scale: `glimmervoid watch` is a second Node process at 76 to 79 MB; each `claude`
child runs 270 to 410 MB.

## Gotchas hit while measuring

- `node dist/server/index.js --port N` ignores `--port`; only `GLIMMERVOID_PORT` works there, while the
  port-in-use error still suggests `--port`.
- `/control` refuses an upgrade with no `Origin` header (non-101), so a headless client must send one.

import path from 'node:path';

import { errorMessage } from '../../shared/text.ts';
import { writeJsonAtomic } from '../json-file.ts';
import type { SharedClock } from '../lanes/lane-runner.ts';
import { GITHUB_USAGE_WINDOW_MS, callsWithinWindow, githubUsageLogLine, summarizeGithubUsage } from './core/github-usage-core.ts';
import type { GithubCall, GithubUsageRecorder } from './core/github-usage-core.ts';
import type { GithubRateLimitResources } from './core/github-rate-limit-core.ts';
import { clock as timeClock } from '../../shared/clock.ts';

const GITHUB_USAGE_FILE_NAME = 'github-usage.json';
const SNAPSHOT_INTERVAL_MS = 60_000;
const LOG_LINE_TOP_OPERATIONS = 5;

function githubUsageFilePath(homeDir: string): string {
  return path.join(homeDir, GITHUB_USAGE_FILE_NAME);
}

function createGithubUsageLedger({ homeDir, readAccountPool, log, now = timeClock.nowMs }: {
  homeDir: string;
  readAccountPool: () => Promise<GithubRateLimitResources | null>;
  log: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}) {
  let calls: GithubCall[] = [];
  const recordingSinceMs = now();
  let lastLogLineAtMs = recordingSinceMs;

  const recorder: GithubUsageRecorder = {
    record(call) {
      calls.push({ ...call, atMs: now() });
    },
  };

  async function writeSnapshot(): Promise<void> {
    const nowMs = now();
    calls = callsWithinWindow(calls, nowMs);
    const account = await readAccountPool().catch(() => null);
    const snapshot = summarizeGithubUsage(calls, account, nowMs, recordingSinceMs);
    await writeJsonAtomic(githubUsageFilePath(homeDir), snapshot).catch((error: unknown) => log.warn(`[github-usage] snapshot write failed: ${errorMessage(error)}`));
    if (nowMs - lastLogLineAtMs < GITHUB_USAGE_WINDOW_MS) return;
    lastLogLineAtMs = nowMs;
    log.info(githubUsageLogLine(snapshot, LOG_LINE_TOP_OPERATIONS));
  }

  function start(clock: Pick<SharedClock, 'schedule'>): () => void {
    return clock.schedule(writeSnapshot, SNAPSHOT_INTERVAL_MS);
  }

  return { recorder, start };
}

export { createGithubUsageLedger, githubUsageFilePath };

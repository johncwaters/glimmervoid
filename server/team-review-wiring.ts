import fs from 'node:fs/promises';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { TEAM_REVIEW_LANE_ID, TEAM_REVIEW_STATE_FILENAME } from './core/team-review-core.ts';
import {
  awaitSessionExit, createJobResultFile, readResultFile, registerEphemeralSession,
} from './ephemeral-session.ts';
import type { JobResultFile, RecordLane, ResultFileOutcome, SpawnGate } from './ephemeral-session.ts';
import { writeJsonAtomic } from './json-file.ts';
import type { PrState } from './team-review-poller.ts';

interface TeamReviewWiringConfig {
  replayBufferKB?: number;
}

interface TeamReviewWiringOptions {
  config: TeamReviewWiringConfig;
  reviewSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  makeSession?: (options: SessionOptions) => Session;
}

const REVIEW_VERDICTS = new Set(['CLEAN', 'RESOLVED', 'CHANGES', 'ERROR']);

function readReviewResult(resultPath: string): ResultFileOutcome {
  return readResultFile(resultPath, REVIEW_VERDICTS);
}

function createTeamReviewWiring({
  config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate,
  recordLane = null,
  makeSession = (options: SessionOptions) => new Session(options),
}: TeamReviewWiringOptions) {
  function makeReviewSession(
    { id, name, path: cwd, initialPrompt }: { id: string; name: string; path: string; initialPrompt: string },
  ): Session {
    const sess = makeSession({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs: ['-p'],
      initialPrompt,
      ephemeral: true,
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({ map: reviewSessions, id, sess, closeSessionDataClients, logPrefix: TEAM_REVIEW_LANE_ID, name, recordLane });
    return sess;
  }

  async function spawnTeamReview({ cwd, number, headSha, slug, signal, buildPrompt }: {
    cwd: string;
    number: number;
    headSha: string;
    slug: string;
    signal?: AbortSignal | null;
    buildPrompt: (resultPath: string) => string;
  }) {
    const safeSlug = String(slug).replace(/[^\w.-]+/g, '-');
    let resultFile: JobResultFile | null = null;
    try {
      resultFile = await createJobResultFile(`glimmervoid-pr-${safeSlug}-${number}-${headSha}`);
      const id = `team-review:${slug}#${number}`;
      const sess = makeReviewSession({ id, name: `Team review ${slug}#${number}`, path: cwd, initialPrompt: buildPrompt(resultFile.path) });
      await awaitSessionExit(sess, { signal, spawnGate });
      return readReviewResult(resultFile.path);
    } catch (e) {
      const failure = (e ?? {}) as { message?: unknown };
      return { verdict: 'ERROR', summary: String(failure.message || e) };
    } finally {
      if (resultFile) await resultFile.cleanup();
    }
  }

  const prStatePath = path.join(glimmervoidHomeDir(), TEAM_REVIEW_STATE_FILENAME);
  async function readPrState(): Promise<PrState> {
    try { return JSON.parse(await fs.readFile(prStatePath, 'utf8')); }
    catch { return {}; }
  }
  async function writePrState(state: PrState): Promise<void> {
    await writeJsonAtomic(prStatePath, state, { mkdir: true });
  }

  return { spawnTeamReview, readPrState, writePrState, makeReviewSession };
}

export { createTeamReviewWiring, readReviewResult };
export type { TeamReviewWiringConfig, TeamReviewWiringOptions };

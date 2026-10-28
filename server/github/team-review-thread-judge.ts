import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import type { LaneSpawn } from '../lanes/lane-spawn.ts';
import { parseThreadJudgeResult } from './core/team-review-threads-core.ts';
import type { TeamReviewThreadResult } from '../../shared/contracts/team-review.ts';
import { reviewAgentAdapterId, reviewerAgentArgs } from './core/team-review-core.ts';
import type { ReviewerChoice } from './core/team-review-core.ts';

export const THREAD_JUDGE_TOOLS = Object.freeze(['Read', 'Write']);
const THREAD_JUDGE_TIMEOUT_MS = 120000;

export function createThreadJudge(spawn: LaneSpawn, readReviewer: () => ReviewerChoice | null, shutdownSignal?: AbortSignal): (prompt: string) => Promise<TeamReviewThreadResult | null> {
  return async (prompt) => {
    const reviewer = readReviewer();
    if (reviewer === null) return null;
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-thread-judge-'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), THREAD_JUDGE_TIMEOUT_MS);
    timeout.unref();
    try {
      await fs.writeFile(path.join(workDir, 'thread-prompt.txt'), prompt, 'utf8');
      const signal = shutdownSignal ? AbortSignal.any([controller.signal, shutdownSignal]) : controller.signal;
      if (signal.aborted) return null;
      await spawn({
        id: `team-review-thread:${randomUUID()}`, name: 'Review thread judgement', cwd: workDir,
        prompt: 'Read thread-prompt.txt and follow its instructions', agent: reviewAgentAdapterId(reviewer.agent),
        extraArgs: reviewerAgentArgs(reviewer), signal,
      });
      if (signal.aborted) return null;
      return parseThreadJudgeResult(await readLaneResultFile(path.join(workDir, 'thread-result.json')));
    } finally {
      clearTimeout(timeout);
      await fs.rm(workDir, { recursive: true, force: true });
    }
  };
}

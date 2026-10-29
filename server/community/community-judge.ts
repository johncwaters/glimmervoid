import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import type { LaneSpawn } from '../lanes/lane-spawn.ts';
import type { CommunityItem } from '../../shared/contracts/community.ts';
import * as core from './core/community-core.ts';

const COMMUNITY_JUDGE_TOOLS = Object.freeze(['Read', 'Write']);

function createCommunityJudge(spawn: LaneSpawn, shutdownSignal?: AbortSignal): (candidates: readonly CommunityItem[]) => Promise<Set<string> | null> {
  return async (candidates) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-community-judge-'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), core.JUDGE_TIMEOUT_MS);
    timeout.unref();
    try {
      const resultPath = path.join(workDir, core.JUDGE_RESULT_FILENAME);
      const { prompt, untrustedItems } = core.buildJudgeRequest(candidates, resultPath);
      await writeUntrustedPayload(workDir, { trust: 'untrusted', source: core.JUDGE_UNTRUSTED_SOURCE, fetchedAt: new Date().toISOString(), items: untrustedItems }, core.JUDGE_MESSAGE_CHARS);
      await fs.writeFile(path.join(workDir, core.JUDGE_PROMPT_FILENAME), prompt, 'utf8');
      const signal = shutdownSignal ? AbortSignal.any([controller.signal, shutdownSignal]) : controller.signal;
      if (signal.aborted) return null;
      await spawn({
        id: `${core.COMMUNITY_LANE_ID}-judge:${randomUUID()}`, name: 'Community question judgement', cwd: workDir,
        prompt: core.JUDGE_BOOTSTRAP_PROMPT, model: core.JUDGE_MODEL, signal,
      });
      if (signal.aborted) return null;
      return core.parseJudgeResult(await readLaneResultFile(resultPath), candidates.map((item) => item.key));
    } finally {
      clearTimeout(timeout);
      await fs.rm(workDir, { recursive: true, force: true });
    }
  };
}

export { COMMUNITY_JUDGE_TOOLS, createCommunityJudge };

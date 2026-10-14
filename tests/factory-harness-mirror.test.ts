import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HARNESS_MIRROR_MAX_IDLE_MS, HARNESS_STATE_FILE_NAME, HARNESS_VERDICT_FILE_NAME, harnessBatchName, harnessRunName } from '../server/factory/core/factory-harness-mirror-core.ts';
import { createFactoryHarnessMirror } from '../server/factory/factory-harness-mirror.ts';

function harnessProject(headSha: string) {
  return {
    projectId: 'seed', projectName: 'Factory seed', headSha, paused: false, orchestrator: null, error: null,
    heading: { action: 'dispatch', reasons: ['ready'] }, orders: [], conflicts: [], unverifiedCompletedWork: [],
  };
}

function stateLine(headSha: string): string {
  return `${JSON.stringify({ arrivedAt: new Date().toISOString(), state: { type: 'factory-state', ts: 1, projects: [harnessProject(headSha)] } })}\n`;
}

test('the harness mirror shows the newest run of every concurrent batch read-only until it has been idle for a day, and nothing before any run', async () => {
  const runsDirectory = await mkdtemp(path.join(os.tmpdir(), 'factory-harness-mirror-'));
  try {
    assert.deepEqual(await createFactoryHarnessMirror({ runsDirectory: path.join(runsDirectory, 'missing') }).listObservedProjects(), []);
    const olderRun = path.join(runsDirectory, harnessBatchName(new Date('2026-10-12T20:07:13.171Z'), '94aa1998'), harnessRunName(1));
    const newerRun = path.join(runsDirectory, harnessBatchName(new Date('2026-10-12T20:16:09.662Z'), '5f782baa'), harnessRunName(1));
    await mkdir(olderRun, { recursive: true });
    await mkdir(newerRun, { recursive: true });
    await writeFile(path.join(olderRun, HARNESS_STATE_FILE_NAME), stateLine('a'.repeat(40)));
    await writeFile(path.join(newerRun, HARNESS_STATE_FILE_NAME), `${stateLine('b'.repeat(40))}${stateLine('c'.repeat(40))}{"arrivedAt":"partial`);
    let nowMs = Date.now();
    const mirror = createFactoryHarnessMirror({ runsDirectory, now: () => nowMs });

    const [running, alsoRunning] = await mirror.listObservedProjects();
    assert.equal(running.projectId, 'harness-5f782baa-seed');
    assert.equal(running.headSha, 'c'.repeat(40));
    assert.deepEqual(running.observedRun, { recordDirectory: newerRun, outcome: null });
    assert.equal(alsoRunning.projectId, 'harness-94aa1998-seed');
    assert.equal(alsoRunning.headSha, 'a'.repeat(40));

    await writeFile(path.join(newerRun, HARNESS_VERDICT_FILE_NAME), JSON.stringify({ outcome: 'fail', failureClass: 'stalled' }));
    assert.equal((await mirror.listObservedProjects())[0].observedRun?.outcome, 'fail (stalled)');

    const lastWrite = new Date(nowMs);
    await utimes(path.join(newerRun, HARNESS_STATE_FILE_NAME), lastWrite, lastWrite);
    await utimes(path.join(newerRun, HARNESS_VERDICT_FILE_NAME), lastWrite, lastWrite);
    await utimes(path.join(olderRun, HARNESS_STATE_FILE_NAME), lastWrite, lastWrite);
    nowMs += HARNESS_MIRROR_MAX_IDLE_MS + 1000;
    assert.deepEqual(await mirror.listObservedProjects(), []);
  } finally {
    await rm(runsDirectory, { recursive: true, force: true });
  }
});

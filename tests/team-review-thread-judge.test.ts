import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildLanePermissions } from '../server/core/lane-permissions-core.ts';
import { LANE_SPAWN_DENY_TOOLS } from '../server/lane-spawn.ts';
import { THREAD_JUDGE_TOOLS, createThreadJudge } from '../server/team-review-thread-judge.ts';

test('thread judge uses a constant bootstrap, validates its result and removes its work directory', async () => {
  let workDir = '';
  const judge = createThreadJudge(async (options) => {
    workDir = options.cwd;
    assert.equal(options.prompt, 'Read thread-prompt.txt and follow its instructions');
    assert.equal(options.model, 'sonnet');
    assert.equal(await fs.readFile(path.join(workDir, 'thread-prompt.txt'), 'utf8'), 'Synthetic thread evidence');
    await fs.writeFile(path.join(workDir, 'thread-result.json'), JSON.stringify({ addressed: true, reason: 'Guard added' }));
  });
  assert.deepEqual(await judge('Synthetic thread evidence'), { addressed: true, reason: 'Guard added' });
  await assert.rejects(fs.stat(workDir), { code: 'ENOENT' });
});

test('missing, invalid and aborted judge results never produce a usable decision', async () => {
  for (const output of [null, '{broken', '{"addressed":"true","reason":"claim"}']) {
    let workDir = '';
    const judge = createThreadJudge(async ({ cwd }) => {
      workDir = cwd;
      if (output !== null) await fs.writeFile(path.join(cwd, 'thread-result.json'), output);
    });
    assert.equal(await judge('Synthetic evidence'), null);
    await assert.rejects(fs.stat(workDir), { code: 'ENOENT' });
  }
  const controller = new AbortController();
  const judge = createThreadJudge(async ({ cwd }) => {
    await fs.writeFile(path.join(cwd, 'thread-result.json'), '{"addressed":true,"reason":"Claim"}');
    controller.abort();
  }, controller.signal);
  assert.equal(await judge('Synthetic evidence'), null);
});

test('the judge lane may only read its prompt file and write its result file', async () => {
  assert.deepEqual([...THREAD_JUDGE_TOOLS], ['Read', 'Write']);
  const { args, permissions } = buildLanePermissions({ denyTools: LANE_SPAWN_DENY_TOOLS, allowTools: THREAD_JUDGE_TOOLS });
  assert.deepEqual(args.slice(0, 2), ['--tools', 'Read,Write']);
  assert.deepEqual(permissions.deny, [...LANE_SPAWN_DENY_TOOLS]);
  const wiringSource = await fs.readFile(path.join(import.meta.dirname, '..', 'server', 'team-review-wiring.ts'), 'utf8');
  assert.ok(wiringSource.includes('allowTools: THREAD_JUDGE_TOOLS'), 'the wiring hands the judge its tool list; a default lane keeps Glob and Grep');
});

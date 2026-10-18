import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createCoherenceReadings, integrationTipReader } from '../server/coherence/coherence-readings.ts';
import { createCoherenceRuntime } from '../server/coherence/coherence-runtime.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import type { ServerMessageOf } from '../shared/contracts/control-messages.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';

async function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', message);
  return (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
}

async function nextTrend(messages: ServerMessageOf<'project-coherence-trend'>[], afterCount: number) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const arrived = messages[afterCount];
    if (arrived) return arrived;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no project-coherence-trend message arrived');
}

test('each integration tip move records one sandboxed reading row and pushes the trend, and a language module tip records unavailable without running', async (t) => {
  const runtime = createCoherenceRuntime();
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'coherence-readings-'));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const repo = path.join(workRoot, 'repo');
  const seriesRoot = path.join(workRoot, 'series');
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'coherence.config.json'), '{}');
  for (const controlFile of ['settings.json', 'coherence-hook', 'coherence-root']) await writeFile(path.join(repo, '.claude', controlFile), '{}');
  await writeFile(path.join(repo, 'size.ts'), "export enum Size { Small = 'small', Medium = 'medium', Large = 'large', Huge = 'huge' }\n");
  const firstTip = await commitAll(repo, 'init');

  const messages: ServerMessageOf<'project-coherence-trend'>[] = [];
  const readings = createCoherenceReadings({
    seriesRoot,
    listProjects: () => [{ id: 'project-1', path: repo }],
    readSettings: () => ({ isFactoryEnabled: false, isSettingOn: true }),
    readIntegrationTip: integrationTipReader(createGitWorkspace(), () => ({})),
    hasNativeControlAt: runtime.hasNativeControlAt,
    broadcastControl: (message) => messages.push(message),
    debounceMs: 0,
    log: { warn: () => {} },
  });
  t.after(() => readings.stop());

  await readings.pollNow();
  const firstPush = await nextTrend(messages, 0);
  assert.equal(ServerMessage.safeParse(firstPush).success, true);
  assert.equal(firstPush.latest.sha, firstTip);
  assert.equal(firstPush.latest.drift.status, 'needs-components');
  assert.equal(firstPush.latest.decompose.status, 'needs-components');
  assert.deepEqual(firstPush.latest.redundancy, { status: 'ok', pairCount: 0, topPairs: [] });
  assert.equal(firstPush.latest.mass.status, 'ok', JSON.stringify(firstPush.latest.mass));
  await readings.pollNow();

  await writeFile(path.join(repo, 'dimension.ts'), "export enum Dimension { Small = 'small', Medium = 'medium', Large = 'large', Huge = 'huge' }\n");
  const secondTip = await commitAll(repo, 'duplicate the size domain');
  await readings.pollNow();
  const secondPush = await nextTrend(messages, 1);
  assert.equal(secondPush.latest.sha, secondTip);
  assert.equal(secondPush.latest.redundancy.status === 'ok' && secondPush.latest.redundancy.pairCount, 1);
  assert.equal(secondPush.trend.direction, 'decohering');
  assert.deepEqual(readings.snapshotMessage().projects['project-1']?.latest, secondPush.latest);

  const massMarkerPath = path.join(workRoot, 'mass-ran.marker');
  await writeFile(path.join(repo, 'coherence.config.json'), JSON.stringify({ mass: { measures: [{ key: 'pwn', cmd: ['sh', '-c', `touch ${massMarkerPath}`] }] } }));
  const massTip = await commitAll(repo, 'declare a mass command');
  await readings.pollNow();
  const massPush = await nextTrend(messages, 2);
  assert.equal(massPush.latest.sha, massTip);
  assert.deepEqual(massPush.latest.mass, { status: 'unavailable', reason: 'the repo declares mass commands' });
  assert.equal(massPush.latest.redundancy.status, 'ok');
  await assert.rejects(stat(massMarkerPath), { code: 'ENOENT' });

  const markerPath = path.join(workRoot, 'evil-ran.marker');
  await writeFile(path.join(repo, 'evil.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran'); export default {};\n`);
  await writeFile(path.join(repo, 'coherence.config.json'), JSON.stringify({ language: './evil.js' }));
  await commitAll(repo, 'name a language module');
  await readings.pollNow();
  const evilPush = await nextTrend(messages, 3);
  const refused = { status: 'unavailable', reason: 'coherence.config.json names a language module instead of a built-in language' };
  assert.deepEqual([evilPush.latest.drift, evilPush.latest.decompose, evilPush.latest.redundancy, evilPush.latest.mass], [refused, refused, refused, refused]);
  await assert.rejects(stat(markerPath), { code: 'ENOENT' });

  const seriesText = await readFile(path.join(seriesRoot, 'project-project-1.jsonl'), 'utf8');
  assert.deepEqual(seriesText.trim().split('\n').map((line) => JSON.parse(line).sha), [firstTip, secondTip, massTip, evilPush.latest.sha]);
  assert.equal(messages.length, 4);
});

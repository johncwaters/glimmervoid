import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createCoherenceRuntime } from '../server/coherence/coherence-runtime.ts';
import { createCoherenceSessionFeed } from '../server/coherence/coherence-session-feed.ts';
import type { ServerMessageOf } from '../shared/contracts/control-messages.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';

const COHERENCE_SESSION_ID = '11111111-2222-4333-8444-555555555555';

async function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function sessionAt(cwd: string, baseSha: string, agentId: string) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    id: `glimmervoid-session-${agentId}`, resumeSessionId: COHERENCE_SESSION_ID, baseSha, coherenceHooks: { active: true as const }, agentId, effectiveCwd: () => cwd,
  });
}

async function nextMessage(messages: ServerMessageOf<'session-coherence'>[], afterCount: number) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const arrived = messages[afterCount];
    if (arrived) return arrived;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no session-coherence message arrived');
}

test('a turn end pushes the journal line and a measured regulate next action, and a language module config never runs even swapped in mid-turn', async (t) => {
  const { cliPath } = createCoherenceRuntime();
  assert.ok(cliPath);
  const repo = await mkdtemp(path.join(os.tmpdir(), 'coherence-feed-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'coherence.config.json'), '{}');
  await writeFile(path.join(repo, 'index.ts'), 'export const answer = 42;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'init');
  const baseSha = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  await execFileAsync(process.execPath, [cliPath, 'decide', 'use plain files', '--because', 'simplest', '--session', COHERENCE_SESSION_ID], { cwd: repo, encoding: 'utf8' });

  const messages: ServerMessageOf<'session-coherence'>[] = [];
  const feed = createCoherenceSessionFeed({ broadcastControl: (message) => messages.push(message), debounceMs: 0, log: { warn: () => {} } });
  const session = sessionAt(repo, baseSha, 'claude-code');
  feed.attachSession(session);
  feed.onTurnEnd(session);
  const firstReading = await nextMessage(messages, 0);
  assert.equal(ServerMessage.safeParse(firstReading).success, true);
  assert.equal(firstReading.journal.ok && firstReading.journal.latest?.text, 'use plain files');
  assert.equal(firstReading.regulation.ok && firstReading.regulation.nextAction.remaining, 0, JSON.stringify(firstReading.regulation));
  const journal = await feed.readJournal(session);
  assert.equal(journal.ok && journal.entries.length, 1);
  assert.deepEqual(Object.keys(feed.snapshotMessage().sessions), [session.id]);

  await writeFile(path.join(repo, 'index.ts'), 'export const answer = 43;\n');
  const countBeforeChange = messages.length;
  feed.onTurnEnd(session);
  const changedTreeReading = await nextMessage(messages, countBeforeChange);
  assert.equal(changedTreeReading.regulation.ok && changedTreeReading.regulation.nextAction.remaining, 0, JSON.stringify(changedTreeReading.regulation));

  const markerPath = path.join(repo, 'evil-ran.marker');
  await writeFile(path.join(repo, 'evil.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran'); export default {};\n`);
  await writeFile(path.join(repo, 'coherence.config.json'), JSON.stringify({ language: './evil.js' }));
  const countBeforeEvil = messages.length;
  feed.onTurnEnd(session);
  const evilConfigReading = await nextMessage(messages, countBeforeEvil);
  assert.deepEqual(evilConfigReading.regulation, { ok: false, reason: 'coherence.config.json names a language module instead of a built-in language' });
  await assert.rejects(stat(markerPath), { code: 'ENOENT' });

  const confinedSession = sessionAt(repo, baseSha, 'codex');
  feed.attachSession(confinedSession);
  let isSwapping = true;
  const swapLoop = (async () => {
    for (let swapCount = 0; isSwapping; swapCount += 1) {
      const stagedConfigPath = path.join(repo, `.staged-config-${swapCount % 2}`);
      await writeFile(stagedConfigPath, swapCount % 2 === 0 ? '{}' : JSON.stringify({ language: './evil.js' }));
      await rename(stagedConfigPath, path.join(repo, 'coherence.config.json'));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();
  for (let turn = 0; turn < 5; turn += 1) {
    const countBeforeTurn = messages.length;
    feed.onTurnEnd(confinedSession);
    await nextMessage(messages, countBeforeTurn);
  }
  isSwapping = false;
  await swapLoop;
  await assert.rejects(stat(markerPath), { code: 'ENOENT' });

  session.emit('exit');
  confinedSession.emit('exit');
  assert.deepEqual(feed.snapshotMessage().sessions, {});
});

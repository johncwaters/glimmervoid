import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCoherence } from '../server/coherence/coherence-runtime.ts';
import { createCoherenceSessionFeed } from '../server/coherence/coherence-session-feed.ts';
import { ServerMessage, type ServerMessageOf } from '../shared/contracts/control-messages.ts';
import { installFakeCoherence } from './helpers/coherence-cli.ts';

test('journal --json feed publishes session entries, deduplicates by id and forgets on exit through a repository CLI', async (context) => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'coherence-feed-'));
  context.after(() => rm(worktree, { recursive: true, force: true }));
  const journal = await readFile(new URL('./fixtures/coherence/1.8.0/journal.json', import.meta.url), 'utf8');
  await installFakeCoherence(worktree, { journal });
  const attachment = await resolveCoherence({ worktree, host: 'claude', isSettingOn: true });
  assert.ok(attachment);
  const session = Object.assign(new EventEmitter(), {
    id: 'card-1', resumeSessionId: 's-fixture', coherenceHooks: attachment.hooks, coherenceAttachment: attachment,
    refreshCoherenceHooks: async () => {}, noteAttention: () => ({ ok: true as const, pending: false }),
  });
  const publications = new EventEmitter();
  const feed = createCoherenceSessionFeed({ broadcastControl: (message) => publications.emit('reading', message), debounceMs: 0 });
  feed.attachSession(session);
  const publication = new Promise<ServerMessageOf<'session-coherence'>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('journal publication timed out')), 5000);
    publications.once('reading', (message: ServerMessageOf<'session-coherence'>) => { clearTimeout(timeout); resolve(message); });
  });
  feed.onTurnEnd(session);
  const message = await publication;
  assert.ok(ServerMessage.safeParse(message).success);
  assert.ok(message.journal.ok);
  assert.equal(message.journal.latest?.id, 'df-487a8dab');
  const reading = await feed.readJournal(session);
  assert.ok(reading.ok);
  assert.equal(reading.entries.length, 4);
  assert.deepEqual(await feed.readJournal(session), reading);
  const calls = (await readFile(path.join(worktree, 'coherence-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[] });
  assert.equal(calls.filter(({ args }) => args[0] === 'version').length, 1);
  assert.ok(calls.slice(2).every(({ args }) => JSON.stringify(args) === JSON.stringify(['journal', '--json', '--session', 's-fixture'])));
  await writeFile(path.join(worktree, 'coherence-fixture.json'), JSON.stringify({ version: '1.8.0', journal: 'bad JSON' }));
  assert.equal((await feed.readJournal(session)).ok, false);
  session.emit('exit');
  assert.deepEqual(feed.snapshotMessage().sessions, {});
});

test('a turn end installs drifted Coherence hooks only in a configured repository and notes each failed install', async (context) => {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'coherence-heal-'));
  context.after(() => rm(worktree, { recursive: true, force: true }));
  await installFakeCoherence(worktree, { hooksExitCode: 1 });
  const attachment = await resolveCoherence({ worktree, host: 'claude', isSettingOn: true });
  assert.ok(attachment);
  const notes: string[] = [];
  const heals = new EventEmitter();
  const coherenceAttachment = { ...attachment, healHooks: () => attachment.healHooks().finally(() => heals.emit('done')) };
  const session = Object.assign(new EventEmitter(), {
    id: 'card-heal', resumeSessionId: null, coherenceHooks: attachment.hooks, coherenceAttachment,
    refreshCoherenceHooks: async () => {},
    noteAttention: (note: string) => { notes.push(note); return { ok: true as const, pending: false }; },
  });
  const feed = createCoherenceSessionFeed({ broadcastControl: () => {}, debounceMs: 0 });
  feed.attachSession(session);
  const installCalls = async () => (await readFile(path.join(worktree, 'coherence-calls.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => (JSON.parse(line) as { args: string[] }).args.join(' ')).filter((args) => args.startsWith('hooks install'));
  const settle = async () => {
    const healed = once(heals, 'done');
    const timeout = setTimeout(() => heals.emit('error', new Error('heal timed out')), 5000);
    feed.onTurnEnd(session);
    await healed.finally(() => clearTimeout(timeout));
    await new Promise(setImmediate);
  };
  await settle();
  assert.deepEqual(await installCalls(), []);
  assert.deepEqual(notes, []);
  await writeFile(path.join(worktree, 'coherence.config.json'), '{}');
  await settle();
  assert.deepEqual(await installCalls(), ['hooks install --host claude']);
  assert.deepEqual(notes, ['Coherence hooks could not be installed: hooks install failed with exit code 1']);
  session.emit('exit');
});

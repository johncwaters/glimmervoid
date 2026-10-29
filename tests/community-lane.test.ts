import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommunityPoller } from '../server/community/community-poller.ts';
import type { SourceRows } from '../server/community/community-poller.ts';
import type { CommunityRunResult } from '../server/community/core/community-core.ts';
import type { CommunityStateEntry } from '../shared/contracts/community.ts';
import { createCommunityStateIo } from '../server/community/community-wiring.ts';

const ENABLED_AT = Date.parse('2026-10-28T12:00:00Z');

function forumRow(id: number, createdAt: string, subject: string): Record<string, unknown> {
  return {
    id,
    attributes: JSON.stringify({
      subject, body: `${subject} body`, permalink: `question-${id}`, createdAt, resolved: true, numReplies: 9,
      profile: { data: { id: 7, attributes: { firstName: 'Asker' } } },
    }),
  };
}

type RunItem = (entry: CommunityStateEntry, signal: AbortSignal) => Promise<CommunityRunResult>;

function startPoller(statePath: string, nowMs: () => number, queryForum: (sinceIso: string) => Promise<SourceRows>, runItem?: RunItem, onDraftReady?: (entry: CommunityStateEntry) => void) {
  const stateIo = createCommunityStateIo(statePath, { warn() {} });
  return createCommunityPoller({
    intervalMinutes: 5, queryForum, readState: stateIo.readState, writeState: stateIo.writeState, runItem, onDraftReady,
    now: nowMs, log: { warn() {} },
  });
}

const HIGH_REPORT = [
  'VERDICT: HIGH',
  'GOAL: Send events from a server',
  'CHECKED:',
  '- the capture docs show the endpoint',
  'GAPS:',
  '(none)',
  'OVERALL_SUMMARY:',
  'The docs answer it.',
].join('\n');

test('community lane queues only questions asked after enabling, whatever their status, and keeps them across a restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-lane-'));
  const statePath = path.join(directory, 'community-state.json');
  let currentMs = ENABLED_AT;
  const askedSince: string[] = [];
  let forumRows: Record<string, unknown>[] = [forumRow(1, '2026-10-27T09:00:00Z', 'asked before enabling')];
  const queryForum = async (sinceIso: string): Promise<SourceRows> => {
    askedSince.push(sinceIso);
    return { ok: true, rows: forumRows };
  };
  try {
    const firstRun = startPoller(statePath, () => currentMs, queryForum);
    await firstRun.start();
    assert.deepEqual(askedSince, []);
    assert.deepEqual(firstRun.state().entries, {});

    currentMs += 5 * 60000;
    forumRows = [
      forumRow(2, '2026-10-28T12:01:00Z', 'resolved question with many replies'),
      { id: 3, attributes: '{not json' },
    ];
    await firstRun.tick();
    await firstRun.stop();
    assert.deepEqual(askedSince, ['2026-10-28T12:00:00.000Z']);
    const queued = firstRun.state().entries['forum:2'];
    assert.equal(queued?.status, 'queued');
    assert.equal(queued?.item.url, 'https://posthog.com/questions/question-2');
    assert.deepEqual(Object.keys(firstRun.state().entries), ['forum:2']);

    const restarted = startPoller(statePath, () => currentMs, queryForum);
    await restarted.start();
    await restarted.stop();
    assert.deepEqual(Object.keys(restarted.state().entries), ['forum:2']);
    assert.equal(restarted.state().watermarks.forum, '2026-10-28T12:01:00.000Z');
    assert.equal(askedSince.at(-1), '2026-10-28T12:01:00.000Z');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('community lane runs each queued question once, oldest first, keeping a ready draft, notifying only for it, and failing a malformed report', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-lane-'));
  const statePath = path.join(directory, 'community-state.json');
  let currentMs = ENABLED_AT;
  let forumRows: Record<string, unknown>[] = [];
  const queryForum = async (): Promise<SourceRows> => ({ ok: true, rows: forumRows });
  const ranKeys: string[] = [];
  const runItem: RunItem = async (entry) => {
    ranKeys.push(entry.item.key);
    if (entry.item.key === 'forum:4') return { report: HIGH_REPORT, posting: JSON.stringify({ body: 'Use the capture endpoint.', publicLinks: ['https://posthog.com/docs'] }), error: null };
    return { report: 'VERDICT: SURE\nOVERALL_SUMMARY:\nfine', posting: null, error: null };
  };
  const notifiedKeys: string[] = [];
  try {
    const poller = startPoller(statePath, () => currentMs, queryForum, runItem, (entry) => notifiedKeys.push(entry.item.key));
    await poller.start();
    currentMs += 5 * 60000;
    forumRows = [forumRow(5, '2026-10-28T12:02:00Z', 'second question'), forumRow(4, '2026-10-28T12:01:00Z', 'first question')];
    await poller.tick();
    await poller.tick();
    await poller.stop();

    assert.deepEqual(ranKeys, ['forum:4', 'forum:5']);
    assert.deepEqual(notifiedKeys, ['forum:4']);
    const ready = poller.state().entries['forum:4'];
    assert.equal(ready?.status, 'ready');
    assert.equal(ready?.verdict, 'HIGH');
    assert.deepEqual(ready?.checked, ['the capture docs show the endpoint']);
    assert.deepEqual(ready?.gaps, []);
    assert.equal(ready?.draft?.body, 'Use the capture endpoint.');
    const failed = poller.state().entries['forum:5'];
    assert.equal(failed?.status, 'error');
    assert.match(failed?.error ?? '', /not HIGH, MEDIUM, LOW or FAILED/);
    assert.equal(failed?.draft, null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function drainPendingWork(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('community lane set-aside stops a running question for good and re-run researches a finished one again', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-lane-'));
  const statePath = path.join(directory, 'community-state.json');
  let currentMs = ENABLED_AT;
  let forumRows: Record<string, unknown>[] = [];
  const queryForum = async (): Promise<SourceRows> => ({ ok: true, rows: forumRows });
  const ranKeys: string[] = [];
  const readyRun: CommunityRunResult = { report: HIGH_REPORT, posting: null, error: null };
  const runItem: RunItem = (entry, signal) => {
    ranKeys.push(entry.item.key);
    const isFirstRunOfOldest = entry.item.key === 'forum:4' && ranKeys.filter((key) => key === 'forum:4').length === 1;
    if (!isFirstRunOfOldest) return Promise.resolve(readyRun);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ report: null, posting: null, error: 'aborted' })));
  };
  try {
    const poller = startPoller(statePath, () => currentMs, queryForum, runItem);
    await poller.start();
    currentMs += 5 * 60000;
    forumRows = [forumRow(5, '2026-10-28T12:02:00Z', 'second question'), forumRow(4, '2026-10-28T12:01:00Z', 'first question')];
    await poller.tick();
    assert.equal(poller.state().entries['forum:4']?.status, 'running');

    assert.deepEqual(await poller.applyAction('forum:4', 'set-aside'), { ok: true });
    await drainPendingWork();
    assert.equal(poller.state().entries['forum:4']?.status, 'aside');
    assert.equal(poller.state().entries['forum:5']?.status, 'ready');

    assert.deepEqual(await poller.applyAction('forum:4', 'rerun'), { ok: true });
    await drainPendingWork();
    const rerun = poller.state().entries['forum:4'];
    assert.equal(rerun?.status, 'ready');
    assert.equal(rerun?.verdict, 'HIGH');
    assert.equal(rerun?.attempts, 2);
    assert.deepEqual(ranKeys, ['forum:4', 'forum:5', 'forum:4']);

    const unknown = await poller.applyAction('forum:99', 'rerun');
    assert.equal(unknown.ok, false);
    await poller.stop();
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(saved.entries['forum:4'].status, 'ready');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function discordRow(uuid: string, timestamp: string, channelName: string, messageContent: string): Record<string, unknown> {
  return { uuid, event: 'message_sent', timestamp, channel_id: '222', guild_id: '111', channel_name: channelName, message_content: messageContent };
}

test('community lane admits only allowlisted Discord messages the judge calls questions, reads past rows that make no question, and retries the batch when the judge gives no answer', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'community-lane-'));
  const statePath = path.join(directory, 'community-state.json');
  let currentMs = ENABLED_AT;
  const discordRows = [
    discordRow('question', '2026-10-28T12:01:00Z', 'help', 'How do I capture events from a server?'),
    discordRow('chatter', '2026-10-28T12:02:00Z', 'help', 'thanks all'),
    discordRow('elsewhere', '2026-10-28T12:03:00Z', 'off-topic', 'How do I bake bread?'),
    discordRow('image-only', '2026-10-28T12:04:00Z', 'help', ''),
  ];
  const judgedBatches: string[][] = [];
  let judgeAnswer: Set<string> | null = null;
  const stateIo = createCommunityStateIo(statePath, { warn() {} });
  const poller = createCommunityPoller({
    intervalMinutes: 5, queryForum: async () => ({ ok: true, rows: [] }), readState: stateIo.readState, writeState: stateIo.writeState,
    discord: {
      channels: ['help'],
      query: async () => ({ ok: true, rows: discordRows }),
      judgeQuestions: async (candidates) => {
        judgedBatches.push(candidates.map((item) => item.key));
        return judgeAnswer;
      },
    },
    now: () => currentMs, log: { warn() {} },
  });
  try {
    await poller.start();
    const watermarkBeforeJudging = poller.state().watermarks.discord;

    currentMs += 5 * 60000;
    await poller.tick();
    assert.deepEqual(judgedBatches, [['discord:question', 'discord:chatter']]);
    assert.deepEqual(poller.state().entries, {});
    assert.equal(poller.state().watermarks.discord, watermarkBeforeJudging);

    judgeAnswer = new Set(['discord:question']);
    currentMs += 31 * 60000;
    await poller.tick();
    await poller.stop();
    assert.deepEqual(Object.keys(poller.state().entries), ['discord:question']);
    const admitted = poller.state().entries['discord:question'];
    assert.equal(admitted?.item.url, 'https://discord.com/channels/111/222');
    assert.equal(admitted?.item.author, 'Discord member');
    assert.equal(poller.state().watermarks.discord, '2026-10-28T12:04:00.000Z');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

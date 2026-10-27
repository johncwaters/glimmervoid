import test from 'node:test';
import assert from 'node:assert/strict';

import { TraceCheckpoint } from '../shared/contracts/trace.ts';

test('a checkpoint defaults legacy subagent offsets and round-trips explicit offsets', () => {
  const legacyCheckpoint = {
    transcriptPath: '/tmp/session.jsonl',
    vendorSessionId: 'vendor-session',
    offset: 4096,
    ingestedSubagentPaths: ['/tmp/session/subagents/agent-a1.jsonl'],
    offsetByTranscriptPath: { '/tmp/session.jsonl': 4096 },
  };
  const checkpoint = {
    ...legacyCheckpoint,
    subagentOffsetByPath: { '/tmp/session/subagents/agent-a1.jsonl': 2048 },
  };

  assert.deepEqual(TraceCheckpoint.parse(checkpoint), checkpoint);
  assert.deepEqual(TraceCheckpoint.parse(legacyCheckpoint), { ...legacyCheckpoint, subagentOffsetByPath: {} });
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, offset: -1 }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, offset: 1.5 }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, transcriptPath: '' }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, ingestedSubagentPaths: undefined }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, offsetByTranscriptPath: { '/tmp/a.jsonl': -1 } }).success, false);
  assert.equal(TraceCheckpoint.safeParse({ ...checkpoint, subagentOffsetByPath: { '/tmp/a.jsonl': -1 } }).success, false);
  assert.deepEqual(
    TraceCheckpoint.parse({ ...checkpoint, offsetByTranscriptPath: undefined }).offsetByTranscriptPath,
    {},
  );
});

test('a checkpoint accepts both offset-less paths and legacy unions of every ingested subagent path', () => {
  const offsetPath = '/tmp/session/subagents/agent-a1.jsonl';
  const offsetLessPath = '/tmp/session/subagents/agent-a2.jsonl';
  const baseCheckpoint = {
    transcriptPath: '/tmp/session.jsonl',
    vendorSessionId: 'vendor-session',
    offset: 4096,
    offsetByTranscriptPath: { '/tmp/session.jsonl': 4096 },
    subagentOffsetByPath: { [offsetPath]: 2048 },
  };
  assert.deepEqual(TraceCheckpoint.parse({
    ...baseCheckpoint,
    ingestedSubagentPaths: [offsetLessPath],
  }).ingestedSubagentPaths, [offsetLessPath]);
  assert.deepEqual(TraceCheckpoint.parse({
    ...baseCheckpoint,
    ingestedSubagentPaths: [offsetPath, offsetLessPath],
  }).ingestedSubagentPaths, [offsetPath, offsetLessPath]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefocusReminder, refocusReplyFor, sessionStartContextOutput } from '../session/core/refocus-core.ts';
import type { RefocusContext } from '../session/core/refocus-core.ts';

const reminderPrefix = 'Context was just compacted. ';
const reminderSuffix = ' Before your next step, check it still serves this intent and drop work that does not.';

for (const { name, taskTitle, latestPlanTitle, expectedIntent } of [
  { name: 'both titles', taskTitle: 'Fix relay', latestPlanTitle: 'Return context', expectedIntent: 'Current task: "Fix relay". Latest plan: "Return context".' },
  { name: 'only task', taskTitle: 'Fix relay', latestPlanTitle: null, expectedIntent: 'Current task: "Fix relay".' },
  { name: 'only plan', taskTitle: null, latestPlanTitle: 'Return context', expectedIntent: 'Latest plan: "Return context".' },
  { name: 'neither title', taskTitle: null, latestPlanTitle: null, expectedIntent: null },
  { name: 'empty titles', taskTitle: '', latestPlanTitle: '   ', expectedIntent: null },
]) {
  test(`buildRefocusReminder handles ${name}`, () => {
    assert.equal(buildRefocusReminder({ taskTitle, latestPlanTitle }), expectedIntent === null ? null : `${reminderPrefix}${expectedIntent}${reminderSuffix}`);
  });
}

for (const body of [null, '', '{invalid', 'null', '[]', '{}', '{"hookSpecificOutput":null}', '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"text"}}', '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":42}}']) {
  test(`sessionStartContextOutput ignores invalid response ${body}`, () => {
    assert.equal(sessionStartContextOutput(body), null);
  });
}

test('sessionStartContextOutput strips unrelated response fields', () => {
  const hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: 'Current intent' };
  assert.equal(sessionStartContextOutput(JSON.stringify({ ok: true, hookSpecificOutput: { ...hookSpecificOutput, ignored: true } })), JSON.stringify({ hookSpecificOutput }));
});

const titledContext: RefocusContext = { taskTitle: 'Fix relay', latestPlanTitle: null };

for (const { name, accepted, event, source } of [
  { name: 'a rejected hook', accepted: false, event: 'SessionStart', source: 'compact' },
  { name: 'a non-SessionStart event', accepted: true, event: 'statusline', source: 'compact' },
  { name: 'a startup SessionStart', accepted: true, event: 'sessionstart', source: 'startup' },
  { name: 'a resume SessionStart', accepted: true, event: 'sessionstart', source: 'resume' },
  { name: 'a SessionStart without a source', accepted: true, event: 'sessionstart', source: undefined },
]) {
  test(`refocusReplyFor skips the context lookup for ${name}`, () => {
    let contextReads = 0;
    const reply = refocusReplyFor({ accepted, event, payload: { source }, readContext: () => { contextReads += 1; return titledContext; } });
    assert.equal(reply, null);
    assert.equal(contextReads, 0);
  });
}

test('refocusReplyFor answers an accepted compact SessionStart with the reminder envelope', () => {
  assert.deepEqual(refocusReplyFor({ accepted: true, event: 'SessionStart', payload: { source: 'compact' }, readContext: () => titledContext }), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${reminderPrefix}Current task: "Fix relay".${reminderSuffix}` },
  });
});

test('refocusReplyFor returns null for a compact SessionStart with no titles', () => {
  assert.equal(refocusReplyFor({ accepted: true, event: 'sessionstart', payload: { source: 'compact' }, readContext: () => ({ taskTitle: null, latestPlanTitle: null }) }), null);
});

test('refocusReplyFor output round-trips through the relay contract', () => {
  const reply = refocusReplyFor({ accepted: true, event: 'sessionstart', payload: { source: 'compact' }, readContext: () => titledContext });
  assert.equal(sessionStartContextOutput(JSON.stringify({ ok: true, ...reply })), JSON.stringify(reply));
});

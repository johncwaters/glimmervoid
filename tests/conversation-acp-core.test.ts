import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TraceRecord } from '../shared/contracts/trace.ts';
import type { DriverListener } from '../session/drivers/driver.ts';
import { acpRecordsFromUpdate, createAcpTraceState, flushAcpTraceState } from '../server/core/conversation/acp-core.ts';
import { traceRecordsFromTranscriptLine } from '../server/core/trace-core.ts';
import { driverSource } from '../server/trace/conversation-sources.ts';
import type { DriverConversationSource, SubscribeDriverEvents } from '../server/trace/conversation-sources.ts';
import { appendChatRecords, createChatPartsState, endChatTurn } from '../public/chat/chat-parts-core.ts';
import type { ChatPart, TurnPart } from '../public/chat/chat-part.ts';
import { listAcpSpikeRecordings, readAcpSpikeRecording } from './fixtures/acp-spike-recordings.ts';
import type { ReplayEvent } from './fixtures/acp-spike-recordings.ts';

const CLAUDE_TRANSCRIPT_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'conversation', 'claude-transcript.jsonl');
const BASE_TS = 1_764_000_000_000;

function readRecordingEvents(agentName: string, scenarioFile: string): ReplayEvent[] {
  return readAcpSpikeRecording(agentName, scenarioFile, BASE_TS);
}

function replayThroughDriverSource(replayEvents: readonly ReplayEvent[]): TraceRecord[] {
  const source: DriverConversationSource = driverSource();
  assert.equal(source.kind, 'driver');
  const listeners = new Set<DriverListener>();
  const subscribeEvents: SubscribeDriverEvents = (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  let currentTs = BASE_TS;
  const collected: TraceRecord[] = [];
  const stop = source.subscribe(
    subscribeEvents,
    (records) => { collected.push(...records); },
    () => currentTs,
  );
  for (const item of replayEvents) {
    currentTs = item.ts;
    for (const listener of listeners) listener(item.event);
  }
  stop();
  return collected;
}

function chatPartsFromRecords(records: readonly TraceRecord[], workingDirectory: string | null = null): ChatPart[] {
  const state = createChatPartsState(workingDirectory);
  const partsById = new Map<string, ChatPart>();
  const recordParts = (emitted: readonly ChatPart[]) => {
    for (const part of emitted) partsById.set(part.id, part);
  };
  recordParts(appendChatRecords(state, records).parts);
  recordParts(endChatTurn(state));
  return [...partsById.values()];
}

function turnPartsOf(parts: readonly ChatPart[]): TurnPart[] {
  return parts.filter((part): part is TurnPart => part.kind === 'turn');
}

test('every ACP spike recording across Claude Code, Codex, and Antigravity replays into schema-valid TraceRecords', () => {
  const agents = ['claude', 'codex', 'antigravity'];
  let totalFiles = 0;
  let totalRecords = 0;
  for (const agentName of agents) {
    const scenarioFiles = listAcpSpikeRecordings(agentName);
    assert.ok(scenarioFiles.length > 0, `expected recordings for ${agentName}`);
    for (const scenarioFile of scenarioFiles) {
      totalFiles += 1;
      const records = replayThroughDriverSource(readRecordingEvents(agentName, scenarioFile));
      assert.ok(records.length > 0, `expected records from ${agentName}/${scenarioFile}`);
      totalRecords += records.length;
      for (const record of records) {
        const parsed = TraceRecord.safeParse(record);
        assert.ok(parsed.success, `${agentName}/${scenarioFile} invalid record: ${JSON.stringify(record)}`);
      }
    }
  }
  assert.ok(totalFiles >= 30, `expected all spike recordings, got ${totalFiles}`);
  assert.ok(totalRecords > 100);
});

test('chunks join by messageId for Claude and Codex and by consecutive run for Antigravity', () => {
  const claudeSetup = replayThroughDriverSource(readRecordingEvents('claude', 'setup.jsonl'));
  const claudeAssistant = claudeSetup.filter((record) => record.kind === 'assistant');
  assert.equal(claudeAssistant.length, 1);
  assert.ok(claudeAssistant[0].uuid?.startsWith('msg_'));
  assert.ok(claudeAssistant[0].text.length > 40);

  const codexSetup = replayThroughDriverSource(readRecordingEvents('codex', 'setup.jsonl'));
  const codexAssistant = codexSetup.filter((record) => record.kind === 'assistant');
  assert.equal(codexAssistant.length, 1);
  assert.ok(codexAssistant[0].uuid?.startsWith('msg_'));

  const antigravityUpdates = replayThroughDriverSource(readRecordingEvents('antigravity', 'updates.jsonl'));
  const antigravityThinking = antigravityUpdates.filter((record) => record.kind === 'thinking');
  const antigravityAssistant = antigravityUpdates.filter((record) => record.kind === 'assistant');
  assert.equal(antigravityThinking.length, 1);
  assert.equal(antigravityAssistant.length, 1);
  assert.equal(antigravityAssistant[0].text, 'PLAN-OK');
});

test('resume replay, model changes, subagents, post-turn updates, and Antigravity task list map as expected', () => {
  for (const [agentName, scenarioFile] of [['claude', 'permissions.jsonl'], ['codex', 'model.jsonl'], ['antigravity', 'model.jsonl']] as const) {
    const resumeRecords = replayThroughDriverSource(readRecordingEvents(agentName, 'resume.jsonl'));
    const prompts = resumeRecords.filter((record) => record.kind === 'prompt');
    assert.equal(prompts.length, 1, `${agentName} resume should emit one replayed prompt`);
    assert.ok(prompts[0].text.includes('ZEBRA-4127'));

    const modelRecords = replayThroughDriverSource(readRecordingEvents(agentName, scenarioFile));
    const modelChanges = modelRecords.filter((record) => record.kind === 'model-change');
    assert.ok(modelChanges.length >= 1, `${agentName}/${scenarioFile} should emit model-change`);
  }

  const claudeSubagents = replayThroughDriverSource(readRecordingEvents('claude', 'subagents.jsonl'));
  const claudeSubagentSignals = claudeSubagents.filter((record) => record.kind === 'subagent');
  assert.deepEqual(claudeSubagentSignals.map((record) => record.phase), ['start', 'stop']);
  assert.equal(claudeSubagentSignals[0].subagentType, 'general-purpose');
  assert.equal(claudeSubagentSignals[0].task, 'Read AGENTS.md first line');
  const claudePostTurnAssistant = claudeSubagents.filter((record) => record.kind === 'assistant');
  assert.equal(claudePostTurnAssistant.length, 2);
  assert.ok(claudePostTurnAssistant[1].text.includes('Background shell'));

  const codexSubagents = replayThroughDriverSource(readRecordingEvents('codex', 'subagents.jsonl'));
  const codexSubagentSignals = codexSubagents.filter((record) => record.kind === 'subagent');
  assert.deepEqual(codexSubagentSignals.map((record) => record.phase), ['start', 'stop']);
  assert.equal(codexSubagentSignals[0].task, 'Read agents');

  const antigravityUpdates = replayThroughDriverSource(readRecordingEvents('antigravity', 'updates.jsonl'));
  const turns = turnPartsOf(chatPartsFromRecords(antigravityUpdates));
  assert.equal(turns.length, 1);
  assert.ok(turns[0].thinkingText !== null && turns[0].thinkingText.length > 20);
  assert.deepEqual(turns[0].taskList, [
    { text: 'Pick the greeting', state: 'done' },
    { text: 'Write the file', state: 'pending' },
    { text: 'Check the file', state: 'pending' },
  ]);
  assert.deepEqual(
    turns[0].segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text),
    ['PLAN-OK'],
  );
});

test('deliberately dropped updates produce zero records and do not split an open chunk', () => {
  const state = createAcpTraceState();
  const context = { vendorSessionId: 'ses-drop-test', now: BASE_TS };
  assert.deepEqual(acpRecordsFromUpdate(state, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hello ' } }, context), []);
  assert.deepEqual(acpRecordsFromUpdate(state, { sessionUpdate: 'usage_update', used: 100, size: 1000 }, context), []);
  assert.deepEqual(acpRecordsFromUpdate(state, { sessionUpdate: 'session_info_update', title: 'Test' }, context), []);
  assert.deepEqual(acpRecordsFromUpdate(state, { sessionUpdate: 'available_commands_update', availableCommands: [] }, context), []);
  assert.deepEqual(acpRecordsFromUpdate(state, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'world' } }, context), []);
  const flushed = flushAcpTraceState(state);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].kind, 'assistant');
  assert.equal(flushed[0].text, 'hello world');
});

test('Claude Code ACP permissions scenario builds the same chat-part structure as a transcript-sourced turn', () => {
  const transcriptRecords = fs.readFileSync(CLAUDE_TRANSCRIPT_FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => traceRecordsFromTranscriptLine(line, { vendorSessionId: 'd52a3005-05a6-48f3-a913-180b01ff3daf', now: BASE_TS }));
  const transcriptTurns = turnPartsOf(chatPartsFromRecords(transcriptRecords));
  assert.equal(transcriptTurns.length, 1);
  const transcriptSegmentKinds = transcriptTurns[0].segments.map((segment) => segment.kind);
  assert.deepEqual(transcriptSegmentKinds, ['tools', 'text']);
  assert.equal(transcriptTurns[0].toolCount, 2);
  assert.equal(transcriptTurns[0].failedCount, 1);

  const acpRecords = replayThroughDriverSource(readRecordingEvents('claude', 'permissions.jsonl'));
  const acpTurns = turnPartsOf(chatPartsFromRecords(acpRecords));
  assert.equal(acpTurns.length, 1);
  const acpTurn = acpTurns[0];
  assert.equal(acpTurn.isOver, true);
  assert.equal(acpTurn.toolCount, 3);
  assert.equal(acpTurn.failedCount, 1);
  assert.equal(acpTurn.fileEdits.fileCount, 1);
  assert.equal(acpTurn.fileEdits.added, 1);
  assert.equal(acpTurn.filePatches.length, 1);
  assert.deepEqual(acpTurn.segments.map((segment) => segment.kind), ['tools', 'text', 'tools', 'text']);

  const firstToolRun = acpTurn.segments[0];
  assert.equal(firstToolRun.kind, 'tools');
  assert.deepEqual(firstToolRun.calls.map((call) => call.state), ['done', 'done']);
  assert.equal(firstToolRun.calls[0].label, 'Write perm-test.txt');
  assert.ok(firstToolRun.calls[1].label.includes('perm-shell.txt'));

  const secondToolRun = acpTurn.segments[2];
  assert.equal(secondToolRun.kind, 'tools');
  assert.deepEqual(secondToolRun.calls.map((call) => call.state), ['failed']);

  const textSegments = acpTurn.segments.filter((segment) => segment.kind === 'text');
  assert.equal(textSegments.length, 2);
  assert.ok(textSegments[0].text.includes('perm-test.txt'));
  assert.ok(textSegments[1].text.includes('perm-shell.txt'));

  const permissionModes = acpRecords.filter((record) => record.kind === 'permission-mode');
  assert.ok(permissionModes.length >= 1);
  assert.equal(permissionModes[0].mode, 'default');
});

test('boundary and lifecycle invariants hold for malformed ids, unknown updates, stacked calls, and stop()', () => {
  const source = driverSource();
  let capturedListener: DriverListener | null = null;
  const received: TraceRecord[] = [];
  const stop = source.subscribe(
    (listener) => {
      capturedListener = listener;
      return () => {};
    },
    (records) => { received.push(...records); },
    () => BASE_TS,
  );
  assert.ok(capturedListener !== null);
  const emit: DriverListener = capturedListener;

  emit({ kind: 'update', agentSessionId: '', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm0', content: { type: 'text', text: 'drop' } } });
  emit({ kind: 'update', agentSessionId: 'ses-1', update: { sessionUpdate: 'future_unknown_update' } as never });
  emit({ kind: 'update', agentSessionId: 'ses-1', update: { sessionUpdate: 'tool_call', toolCallId: '', title: 'Bad', status: 'completed' } });
  emit({ kind: 'update', agentSessionId: 'ses-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'Bash', title: 'Terminal', status: 'pending', rawInput: {} } });
  emit({ kind: 'update', agentSessionId: 'ses-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'Bash', title: 'ls', status: 'in_progress', rawInput: { command: 'ls' } } });
  emit({ kind: 'update', agentSessionId: 'ses-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: '' } });
  emit({ kind: 'turn-end', stopReason: 'end_turn' });

  assert.deepEqual(received.map((record) => record.kind), ['tool_call', 'tool_result']);
  assert.equal(received[1].kind === 'tool_result' ? received[1].content : null, '');

  const countBeforeStop = received.length;
  stop();
  emit({ kind: 'update', agentSessionId: 'ses-1', update: { sessionUpdate: 'notice', severity: 'info', title: 'Late' } });
  assert.equal(received.length, countBeforeStop);
});


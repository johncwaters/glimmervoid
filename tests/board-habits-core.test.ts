import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { habitScoresOf, habitTableOf } from '../harness/board-habits/habits-core.ts';
import type { ToolCall, TrialResult } from '../harness/board-habits/habits-core.ts';

const whiteboardCall = (action: string, isError = false): ToolCall => ({ name: 'mcp__glimmervoid__whiteboard', input: { action }, isError, resultText: isError ? '{"ok":false}' : '{"ok":true}' });
const cliCall = (command: string): ToolCall => ({ name: 'Bash', input: { command }, isError: false, resultText: '' });

const trial: TrialResult = {
  arm: 'head',
  task: 'operator-edit',
  trialIndex: 0,
  turnResults: [
    { ok: true, costUsd: 0.5, text: '', toolCalls: [whiteboardCall('new'), whiteboardCall('put'), whiteboardCall('view')] },
    { ok: true, costUsd: 0.25, text: '', toolCalls: [whiteboardCall('put', true), cliCall('glimmervoid whiteboard put board -'), whiteboardCall('get')] },
    { ok: true, costUsd: 0.25, text: '', toolCalls: [whiteboardCall('get'), { name: 'mcp__glimmervoid__show', input: { path: 'chart.svg' }, isError: false, resultText: '' }, whiteboardCall('render')] },
  ],
  boards: [{
    id: 'board-1',
    elements: {
      parse: { kind: 'box', id: 'parse', title: 'Parse', icon: 'function' },
      notes: { kind: 'box', id: 'notes', title: 'Release notes', lines: [{ text: 'one two three four five six seven eight nine ten eleven twelve' }, { text: 'thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three' }] },
      chartA: { kind: 'box', id: 'chartA', title: 'Chart', media: { source: { path: '/work/chart.svg' } } },
      chartB: { kind: 'box', id: 'chartB', title: 'Chart again', media: { source: { path: '/other/chart.svg' } } },
      wire: { kind: 'wire', id: 'wire' },
    },
  }],
  operatorEditBoxId: 'operator-edit',
};

test('habit scores count looks after changes, reads before follow-up changes, refusals and lost operator edits, and keep failed trials out of the means', () => {
  assert.deepEqual(habitScoresOf(trial), {
    viewedAfterChange: 2 / 3,
    readBeforeChange: 1 / 2,
    boardsCreated: 1,
    newCalls: 1,
    duplicateFileCards: 1,
    refusedPuts: 1,
    operatorEditKept: 0,
    attachCalls: 0,
    showCalls: 1,
    wordyBoxes: 1,
    pictorialShare: 3 / 4,
    costUsd: 1,
  });
  const failedTrial = { ...trial, trialIndex: 2, turnResults: [{ ok: false, costUsd: 0, text: 'API Error: 529', toolCalls: [] }] };
  assert.match(habitTableOf([trial, { ...trial, trialIndex: 1 }, failedTrial]), /\| operator-edit \| head \| 2 \| 0\.67 \| 0\.50 \|.* \| 1 \|$/);
});

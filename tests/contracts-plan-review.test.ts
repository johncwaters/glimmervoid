import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ExitPlanModeInput,
  parseExitPlanModeHookPayload,
  planTitle,
} from '../shared/contracts/plan-review.ts';

const PLAN_BODY = '# Shrink the large owned files\n\n## Context\n\nA size sweep found three files.\n';
const PLAN_FILE_PATH = '/home/u/.claude/plans/recursive-drifting-grove.md';

test('the recorded ExitPlanMode request from a live session parses', () => {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'v2-waiting-plan.jsonl');
  const record = fs.readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === 'hook' && entry.payload?.tool_name === 'ExitPlanMode');
  const parsed = parseExitPlanModeHookPayload(record.payload);
  assert.ok(parsed);
  assert.equal(parsed.planFilePath, '/home/u/.claude/plans/recursive-drifting-grove.md');
  assert.equal(planTitle(parsed.plan), 'Shrink the large owned files');
});

test('ExitPlanModeInput keeps unknown tool input fields instead of rejecting them', () => {
  const parsed = ExitPlanModeInput.parse({ plan: PLAN_BODY, planFilePath: PLAN_FILE_PATH, futureField: true });
  assert.equal(parsed.futureField, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { BrowserConfig, Config, CONFIG_BLOCK_KEYS, CONFIG_SCALAR_KEYS, ConfigUpdate } from '../shared/contracts/config.ts';
import { WorkflowsSettings, WorkflowsState } from '../shared/contracts/workflows.ts';

function validRule(overrides: Record<string, unknown> = {}) {
  return { id: 'ping-me', name: 'Ping me', repos: ['Acme/app'], trigger: 'opened', actions: [{ type: 'notify' }], ...overrides };
}

function firstIssue(candidate: unknown): string {
  const parsed = WorkflowsSettings.safeParse(candidate);
  assert.equal(parsed.success, false);
  return parsed.success ? '' : parsed.error.issues[0]?.message ?? '';
}

test('a rule defaults to disabled with no filters', () => {
  const parsed = WorkflowsSettings.parse({ rules: [validRule()] });
  assert.equal(parsed.rules[0]?.enabled, false);
  assert.deepEqual(parsed.rules[0]?.filters, {});
  assert.deepEqual(WorkflowsSettings.parse({}).rules, []);
});

test('every trigger and action shape parses', () => {
  for (const trigger of ['opened', 'checks-failed', 'review-requested', 'approved', 'commented', 'merged']) {
    assert.equal(WorkflowsSettings.safeParse({ rules: [validRule({ trigger })] }).success, true, trigger);
  }
  const actions = [{ type: 'notify' }, { type: 'spawn', promptTemplate: 'Look at {{url}}' }, { type: 'label', name: 'needs review' }, { type: 'comment', body: 'Thanks' }];
  const filters = { mine: true, teamReviewRequested: true, authors: ['alice'], labels: ['bug'], baseBranches: ['main'] };
  assert.equal(WorkflowsSettings.safeParse({ rules: [validRule({ actions, filters, enabled: true })] }).success, true);
});

test('malformed rules fail closed with a message naming the field', () => {
  assert.match(firstIssue({ rules: [validRule({ trigger: 'pushed' })] }), /trigger must be one of/);
  assert.match(firstIssue({ rules: [validRule({ actions: [{ type: 'merge' }] })] }), /actions\[\]\.type must be one of/);
  assert.match(firstIssue({ rules: [validRule({ actions: [] })] }), /actions must list at least one entry/);
  assert.match(firstIssue({ rules: [validRule({ repos: ['not-a-slug'] })] }), /.+/);
  assert.match(firstIssue({ rules: [validRule({ repos: [] })] }), /repos must list at least one entry/);
  assert.match(firstIssue({ rules: [validRule({ filters: { authors: [] } })] }), /authors must list at least one entry/);
  assert.match(firstIssue({ rules: [validRule({ filters: { reviewer: 'alice' } })] }), /.+/);
  assert.match(firstIssue({ rules: [validRule({ extra: true })] }), /.+/);
  assert.match(firstIssue({ rules: [validRule({ id: 'Ping Me' })] }), /id must be/);
  assert.match(firstIssue({ rules: [validRule(), validRule()] }), /declared more than once/);
  assert.match(firstIssue({ rules: [validRule({ enabled: 'yes' })] }), /enabled must be a boolean/);
  assert.match(firstIssue({ rules: [validRule({ actions: [{ type: 'spawn', promptTemplate: '   ' }] })] }), /must not be blank/);
  assert.match(firstIssue({ rules: [validRule({ actions: [{ type: 'spawn' }] })] }), /promptTemplate/);
  assert.match(firstIssue({ rules: [validRule({ actions: [{ type: 'comment', body: '' }] })] }), /comment body/);
  assert.match(firstIssue({ rules: 'all' }), /rules must be an array/);
});

test('a label that gh would split or read as a flag is refused', () => {
  for (const name of ['bug,urgent', '--remove-label', 'line\nbreak', '', 'x'.repeat(51)]) {
    assert.equal(WorkflowsSettings.safeParse({ rules: [validRule({ actions: [{ type: 'label', name }] })] }).success, false, JSON.stringify(name));
    assert.equal(WorkflowsSettings.safeParse({ rules: [validRule({ filters: { labels: [name] } })] }).success, false, JSON.stringify(name));
  }
});

test('the workflows block is file-only: config.json keeps it, the browser mirror validates it, a dashboard update writes only the switch, limits and rule toggles', () => {
  const workflows = { rules: [validRule()] };
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, workflows }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, workflows: { rules: [validRule({ trigger: 'pushed' })] } }).success, true);
  assert.equal(Config.safeParse({ ...DEFAULT_CONFIG, workflows: 'on' }).success, false);
  assert.equal(BrowserConfig.safeParse({ workflows }).success, true);
  assert.equal(BrowserConfig.safeParse({ workflows: { rules: [validRule({ trigger: 'pushed' })] } }).success, false);
  assert.equal(ConfigUpdate.safeParse({ workflows }).success, false);
  assert.equal(ConfigUpdate.safeParse({ workflows: { enabled: false, maxConcurrentSessions: 5, maxActionsPerPoll: 1, rules: [{ id: validRule().id, enabled: true }] } }).success, true);
  assert.equal(CONFIG_BLOCK_KEYS.includes('workflows'), true);
  assert.equal(CONFIG_SCALAR_KEYS.includes('workflows'), false);
});

test('the snapshot state refuses unknown fields and mixed-case repository keys', () => {
  const pr = {
    repo: 'Acme/app', number: 7, title: 'Fix', url: 'https://github.com/Acme/app/pull/7', author: 'alice', state: 'OPEN',
    createdAt: '2026-10-04T12:00:00Z', mergedAt: null, isDraft: false, isCrossRepository: false,
    baseRefName: 'main', headRefName: 'fix', headRefOid: 'a'.repeat(40), labels: [], commentCount: 0, reviewRequests: [], checksState: null, reviewDecision: null,
  };
  const polled = (prs: unknown[]) => ({ polledAtMs: 1, prs });
  assert.equal(WorkflowsState.safeParse({ repos: { 'acme/app': polled([pr]) } }).success, true);
  assert.equal(WorkflowsState.safeParse({ repos: { 'Acme/app': polled([pr]) } }).success, false);
  assert.equal(WorkflowsState.safeParse({ repos: { 'acme/app': polled([{ ...pr, extra: 1 }]) } }).success, false);
  assert.equal(WorkflowsState.safeParse({ repos: { 'acme/app': [pr] } }).success, false);
  assert.equal(WorkflowsState.safeParse({ repos: { 'acme/app': { prs: [pr] } } }).success, false);
  assert.equal(WorkflowsState.safeParse({ repos: {}, version: 2 }).success, false);
});

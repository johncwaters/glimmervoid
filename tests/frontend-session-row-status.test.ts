import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const PLAN_PROMPT_KIND = 'plan';

test('every session row hides its status word except Plan ready, desktop rail and phone Board alike', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rowOutsidePlanPrompt = `\n.session-row:not([data-prompt="${PLAN_PROMPT_KIND}"])`;

  assert.ok(css.includes(`${rowOutsidePlanPrompt} .session-row-label { display: none; }`));
  assert.ok(css.includes(`${rowOutsidePlanPrompt} .session-row-meta:has(.session-row-signals[hidden]) { display: none; }`));
  assert.doesNotMatch(css, /data-compact-status/);
});

test('the shared session row stamps the prompt kind that the status rule exempts, and words a plan row Plan ready', () => {
  const sessionRowSource = readFileSync(new URL('../public/session-row.ts', import.meta.url), 'utf8');

  assert.ok(sessionRowSource.includes(`const PLAN_PROMPT_KIND = '${PLAN_PROMPT_KIND}'`));
  assert.ok(sessionRowSource.includes("pendingPromptKind === PLAN_PROMPT_KIND ? 'Plan ready' : label"));
  assert.ok(sessionRowSource.includes("row.dataset.prompt = pendingPromptKind ?? ''"));
});

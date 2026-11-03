import test from 'node:test';
import assert from 'node:assert/strict';
import { fitTipDetail, fitTipLabel, TIP_DETAIL_MAX_CHARS, TIP_LABEL_MAX_CHARS } from '../public/hover-tip-core.ts';
import { reviewTierTip } from '../public/github/team-review-view-core.ts';

const ELLIPSIS = String.fromCharCode(0x2026);

test('fitted tip text never exceeds its fixed label or detail length, cut at a word with an ellipsis', () => {
  const longReasons = `A quick pass. Picked because: ${Array.from({ length: 40 }, (_, index) => `reason${index}`).join(', ')}.`;
  for (const [fit, maxChars] of [[fitTipLabel, TIP_LABEL_MAX_CHARS], [fitTipDetail, TIP_DETAIL_MAX_CHARS]] as const) {
    const shown = fit(longReasons);
    assert.ok(shown.length <= maxChars, `${shown.length} > ${maxChars}`);
    assert.ok(shown.endsWith(ELLIPSIS));
    assert.ok(longReasons.startsWith(`${shown.slice(0, -1)} `));
  }
  assert.equal(fitTipLabel('x'.repeat(TIP_LABEL_MAX_CHARS * 2)).length, TIP_LABEL_MAX_CHARS);
  assert.equal(fitTipLabel('Remove session'), 'Remove session');
  const longPathReason = 'The agent reads every changed file. Picked because: touches frontend/src/scenes/authentication/passkeySettings.tsx.';
  assert.match(fitTipDetail(longPathReason), /touches frontend\/src\/scenes/);
});

test('the review tier tip names a risky file by its file name and fits without being cut', () => {
  const tip = reviewTierTip({ tier: 'full', reasons: ['touches frontend/src/scenes/authentication/LoginForm.tsx'] });
  assert.equal(tip.detail, 'The agent reads every changed file. Picked because: touches LoginForm.tsx.');
  assert.ok(!reviewTierTip({ tier: 'stamp', reasons: ['docs and tests only'] }).detail.endsWith(ELLIPSIS));
});

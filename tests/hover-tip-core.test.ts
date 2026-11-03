import test from 'node:test';
import assert from 'node:assert/strict';
import { clampTipText, TIP_DETAIL_MAX_CHARS, TIP_LABEL_MAX_CHARS } from '../public/hover-tip-core.ts';

const ELLIPSIS = String.fromCharCode(0x2026);

test('a hover tip never shows more than its fixed label or detail length, cut at a word with an ellipsis', () => {
  const longReasons = `A quick pass. Picked because: ${Array.from({ length: 40 }, (_, index) => `reason${index}`).join(', ')}.`;
  for (const maxChars of [TIP_LABEL_MAX_CHARS, TIP_DETAIL_MAX_CHARS]) {
    const shown = clampTipText(longReasons, maxChars);
    assert.ok(shown.length <= maxChars, `${shown.length} > ${maxChars}`);
    assert.ok(shown.endsWith(ELLIPSIS));
    assert.ok(longReasons.startsWith(`${shown.slice(0, -1)} `));
  }
  const unbrokenWord = 'x'.repeat(TIP_LABEL_MAX_CHARS * 2);
  assert.equal(clampTipText(unbrokenWord, TIP_LABEL_MAX_CHARS).length, TIP_LABEL_MAX_CHARS);
  assert.equal(clampTipText('Remove session', TIP_LABEL_MAX_CHARS), 'Remove session');
  const longPathReason = 'The agent reads every changed file. Picked because: touches frontend/src/scenes/authentication/passkeySettings.tsx.';
  assert.match(clampTipText(longPathReason, TIP_DETAIL_MAX_CHARS), /touches frontend\/src\/scenes/);
});

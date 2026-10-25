import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const THREAD_ID_PATTERN_OWNER = 'shared/visions-intent-ids.ts';
const threadIdPatternSpelling = /t-\[[^\]]*\]\{8/;

test('only the shared visions ids module spells the thread id pattern', () => {
  const spellers = trackedFiles(/^(?!tests\/).+\.(?:ts|js|mjs)$/).filter((repoPath) => threadIdPatternSpelling.test(readTracked(repoPath)));
  assert.deepEqual(spellers, [THREAD_ID_PATTERN_OWNER], 'server and browser must import VISIONS_THREAD_ID_PATTERN, or a second spelling drifts and ids stop matching');
});

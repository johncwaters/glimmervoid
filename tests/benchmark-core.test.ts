import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgePrompt } from '../server/core/benchmark-core.ts';

test('the judge prompt names each reference by its exact id with no prefix a judge could copy into it', () => {
  const { prompt } = buildJudgePrompt({ references: [{ id: 'c3931176569', text: 'Duplicate key copies', tags: ['human'] }], findings: [], seed: 0 });
  assert.match(prompt, /^referenceId: c3931176569$/m);
  assert.doesNotMatch(prompt, /Rc3931176569/);
});

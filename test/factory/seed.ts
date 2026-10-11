import { createRepositoryWithOrigin } from '../../tests/helpers/factory-fixture.ts';

export async function seedTarget(directory: string) {
  return createRepositoryWithOrigin(directory, 'main', {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test', typecheck: 'node --check src/math.js', lint: 'node --check src/math.js' } }),
    'coherence.config.json': '{}\n',
    'src/math.js': 'export function add(left, right) { return left + right; }\n',
    'test/math.test.js': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\ntest('adds two numbers', () => assert.equal(add(2, 3), 5));\n",
  });
}

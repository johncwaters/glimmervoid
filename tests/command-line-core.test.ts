import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommandLine } from '../server/core/command-line-core.ts';

test('--help after an agent verb subcommand prints help instead of becoming a whiteboard title', () => {
  assert.deepEqual(parseCommandLine(['whiteboard', 'new', '--help']), { kind: 'help' });
  assert.equal(parseCommandLine(['whiteboard', 'new', '--', '--help']).kind, 'subcommand');
  assert.equal(parseCommandLine(['spawn', 'fix the --help output']).kind, 'subcommand');
});

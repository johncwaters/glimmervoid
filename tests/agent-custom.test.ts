import test from 'node:test';
import assert from 'node:assert/strict';

import { createCustomAdapter } from '../session/adapters/custom.ts';
import type { AgentAdapter } from '../session/adapters/index.ts';
import { CustomAgentDeclaration } from '../shared/contracts/index.ts';

const BRAILLE_SPINNER = String.fromCodePoint(0x2839);
const CIRCLE_HALVES_SPINNER = String.fromCodePoint(0x25d1);

function declaredCustomAgent(overrides: Record<string, unknown> = {}) {
  return CustomAgentDeclaration.parse({
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['--no-update-check'],
    ...overrides,
  });
}

function classify(adapter: AgentAdapter, title: string, cwdBasename: string | null = 'project'): string | undefined {
  return adapter.titleProfile.classifyTitle?.(title, { cwdBasename });
}

test('a declared custom agent classifies a spinner title as working', () => {
  const adapter = createCustomAdapter(declaredCustomAgent());
  assert.equal(classify(adapter, `${BRAILLE_SPINNER} project`), 'working');
  assert.equal(classify(adapter, `${CIRCLE_HALVES_SPINNER} project`), 'working');
});

test('a declared busyTitle is working and a declared idleTitle is ready without a cwd basename', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({ busyTitle: 'OpenCode running', idleTitle: 'OpenCode idle' }));
  assert.equal(classify(adapter, 'OpenCode running', null), 'working');
  assert.equal(classify(adapter, 'OpenCode idle', null), 'ready');
});

test('a declared title holding a path separator still fires, since the exact match outranks the path-like guard', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({
    busyTitle: 'opencode: src/session',
    idleTitle: 'opencode: ~/repo',
  }));
  assert.equal(classify(adapter, 'opencode: src/session'), 'working');
  assert.equal(classify(adapter, 'opencode: ~/repo'), 'ready');
  assert.equal(classify(adapter, 'opencode: src/other'), 'ignore');
});

test('a title equal to the cwd basename is ready and a path-like title is ignored', () => {
  const adapter = createCustomAdapter(declaredCustomAgent());
  assert.equal(classify(adapter, 'project'), 'ready');
  assert.equal(classify(adapter, '/home/carbon/project'), 'ignore');
  assert.equal(classify(adapter, 'C:\\work\\project'), 'ignore');
  assert.equal(classify(adapter, 'project', null), 'ignore');
});

test('an unrecognized title is unknown, never a guessed completion', () => {
  const adapter = createCustomAdapter(declaredCustomAgent());
  assert.equal(classify(adapter, 'OpenCode 1.4.2'), 'unknown');
  assert.equal(classify(adapter, 'project (2 files changed)'), 'unknown');
});

test('no title a terminal can emit makes a title-only adapter claim awaiting-input', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({ busyTitle: 'busy', idleTitle: 'idle' }));
  const sweep = [
    'project',
    'idle',
    'busy',
    `${BRAILLE_SPINNER} project`,
    '[ ! ] Action Required | project',
    '[ . ] Action Required | project',
    'Waiting for approval',
    'Allow this command?',
    'permission required: Bash',
    '? project',
    'project ?',
    '',
    ' ',
    'project/subdir',
  ];
  for (const title of sweep) {
    assert.notEqual(classify(adapter, title), 'awaiting-input', `title ${JSON.stringify(title)}`);
  }
});

test('a custom adapter carries no hook profile and declares every capability off', () => {
  const adapter = createCustomAdapter(declaredCustomAgent());
  assert.equal(adapter.hooks, null);
  assert.equal(Object.values(adapter.capabilities).every((value) => value === false), true);
  assert.equal(adapter.renderPackArgs([], '/built'), null);
  assert.equal(adapter.titleProfile.quietUntilFirstPrompt, undefined);
});

test('buildArgs is an argv array of the declared args, with the initial prompt appended last', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({ args: ['--model', 'local', '--no-color'] }));
  assert.deepEqual(adapter.buildArgs(), ['--model', 'local', '--no-color']);
  assert.deepEqual(
    adapter.buildArgs({ initialPrompt: 'do the thing' }),
    ['--model', 'local', '--no-color', 'do the thing'],
  );
});

test('the declared args array survives one adapter mutating the argv it was handed', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({ args: ['--flag'] }));
  adapter.buildArgs().push('injected');
  assert.deepEqual(adapter.buildArgs(), ['--flag']);
});

test('an absolute declared command that exists resolves without a PATH lookup', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({ command: '/opt/agents/opencode' }));
  let lookups = 0;
  const execFile = () => {
    lookups += 1;
    return '';
  };
  const resolved = adapter.resolveCommand({ platform: 'linux', execFile, pathExists: () => true });
  assert.equal(lookups, 0);
  assert.deepEqual(resolved, { path: '/opt/agents/opencode', kind: 'shim' });
});

test('a typo in an absolute declared command reports unresolved rather than a path that is not there', () => {
  const adapter = createCustomAdapter(declaredCustomAgent({ command: '/opt/agents/opencode-typo' }));
  const probed: string[] = [];
  const resolved = adapter.resolveCommand({
    platform: 'linux',
    execFile: () => '',
    pathExists: (candidate) => {
      probed.push(candidate);
      return false;
    },
  });
  assert.deepEqual(probed, ['/opt/agents/opencode-typo']);
  assert.deepEqual(resolved, { path: null, kind: 'unresolved' });
});

test('a bare declared command still resolves through the PATH lookup', () => {
  const adapter = createCustomAdapter(declaredCustomAgent());
  const invocations: string[][] = [];
  const resolved = adapter.resolveCommand({
    platform: 'linux',
    execFile: (file, args) => {
      invocations.push([file, ...args]);
      return '/usr/local/bin/opencode\n';
    },
  });
  assert.deepEqual(invocations, [['which', '-a', 'opencode']]);
  assert.deepEqual(resolved, { path: '/usr/local/bin/opencode', kind: 'shim' });
});

test('the spawn command is a file plus an argv array, never a shell string', () => {
  const adapter = createCustomAdapter(declaredCustomAgent());
  const spawned = adapter.buildSpawnCommand({
    platform: 'linux',
    resolved: { path: '/usr/local/bin/opencode', kind: 'shim' },
    agentArgs: adapter.buildArgs({ initialPrompt: 'go' }),
  });
  assert.equal(spawned.file, 'opencode');
  assert.deepEqual(spawned.args, ['--no-update-check', 'go']);
});

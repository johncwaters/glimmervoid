import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommandLine } from '../server/core/command-line-core.ts';
const NO_GLOBAL_OPTIONS = { configPath: null, port: null };

test('global options before the subcommand name apply and are not handed to the subcommand', () => {
  assert.deepEqual(parseCommandLine(['--config', '/x/config.json', '--port', '4000', 'settings', 'ls']), {
    kind: 'subcommand',
    name: 'settings',
    subcommandArgs: ['ls'],
    globalOptions: { configPath: '/x/config.json', port: '4000' },
  });
});

test('arguments after a settings or agent verb name belong to that subcommand, help and version included', () => {
  assert.deepEqual(parseCommandLine(['settings', 'add', 'note', 'title', '--body', '--version']), {
    kind: 'subcommand', name: 'settings', subcommandArgs: ['add', 'note', 'title', '--body', '--version'], globalOptions: NO_GLOBAL_OPTIONS,
  });
  assert.deepEqual(parseCommandLine(['settings', 'add', 'note', '-h']), {
    kind: 'subcommand', name: 'settings', subcommandArgs: ['add', 'note', '-h'], globalOptions: NO_GLOBAL_OPTIONS,
  });
  assert.deepEqual(parseCommandLine(['settings', 'ls', '--config', '/x']), {
    kind: 'subcommand', name: 'settings', subcommandArgs: ['ls', '--config', '/x'], globalOptions: NO_GLOBAL_OPTIONS,
  });
  assert.deepEqual(parseCommandLine(['spawn', 'fix', 'the', '--port', 'bug', '--doctor']), {
    kind: 'subcommand', name: 'spawn', subcommandArgs: ['fix', 'the', '--port', 'bug', '--doctor'], globalOptions: NO_GLOBAL_OPTIONS,
  });
});

test('an agent verb asked for help or version as its first argument prints usage instead of acting', () => {
  for (const verb of ['spawn', 'attention', 'board']) {
    assert.deepEqual(parseCommandLine([verb, '--help']), { kind: 'help' }, verb);
    assert.deepEqual(parseCommandLine([verb, '-h']), { kind: 'help' }, verb);
    assert.deepEqual(parseCommandLine([verb, '--version']), { kind: 'version' }, verb);
  }
  assert.deepEqual(parseCommandLine(['spawn', 'explain', '--help']), {
    kind: 'subcommand', name: 'spawn', subcommandArgs: ['explain', '--help'], globalOptions: NO_GLOBAL_OPTIONS,
  });
});

test('doctor, pair and visions keep honoring global options written after their name', () => {
  assert.deepEqual(parseCommandLine(['doctor', '--config', '/x']), {
    kind: 'subcommand', name: 'doctor', subcommandArgs: ['--config', '/x'], globalOptions: { configPath: '/x', port: null },
  });
  assert.deepEqual(parseCommandLine(['visions', 'relay', '--port', '4000']), {
    kind: 'subcommand', name: 'visions', subcommandArgs: ['relay', '--port', '4000'], globalOptions: { configPath: null, port: '4000' },
  });
  assert.deepEqual(parseCommandLine(['pair', '--help']), { kind: 'help' });
});

test('help, version and doctor flags before any subcommand keep their global meaning', () => {
  assert.deepEqual(parseCommandLine(['--help', 'settings']), { kind: 'help' });
  assert.deepEqual(parseCommandLine(['-h']), { kind: 'help' });
  assert.deepEqual(parseCommandLine(['--version']), { kind: 'version' });
  assert.deepEqual(parseCommandLine(['--config', '/x', '--doctor']), {
    kind: 'subcommand', name: 'doctor', subcommandArgs: [], globalOptions: { configPath: '/x', port: null },
  });
});

test('no subcommand with only global options boots the server', () => {
  assert.deepEqual(parseCommandLine([]), { kind: 'server', globalOptions: NO_GLOBAL_OPTIONS, isBrowserOpenSkipped: false });
  assert.deepEqual(parseCommandLine(['--port', '4567', '--config', '/x']), {
    kind: 'server', globalOptions: { configPath: '/x', port: '4567' }, isBrowserOpenSkipped: false,
  });
  assert.deepEqual(parseCommandLine(['--no-open']), { kind: 'server', globalOptions: NO_GLOBAL_OPTIONS, isBrowserOpenSkipped: true });
});


import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildAgentEnv } from '../session/core/spawn-env.ts';
import type { AgentEnvOptions, SpawnEnv } from '../session/core/spawn-env.ts';
import claudeCodeAdapter from '../session/adapters/claude-code.ts';
import { ENV_SECRET_BINDINGS } from '../server/core/config-secrets-core.ts';
import { OVERRIDE_TOKEN_ENV } from '../server/claude-credentials.ts';

function claudeSpawnEnv(baseEnv: SpawnEnv, extraEnv?: SpawnEnv | null, options?: AgentEnvOptions) {
  return buildAgentEnv(baseEnv, extraEnv, claudeCodeAdapter.envProfile, options);
}

const SCRUBBED = [
  'CLAUDECODE',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'GLIMMERVOID_PORT',
  'GLIMMERVOID_CONFIG',
];

function fullBase(): SpawnEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/home/u',
    CLAUDECODE: '1',
    CLAUDE_CODE_SSE_PORT: '7777',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_CHILD_SESSION: '1',
    GLIMMERVOID_PORT: '3000',
    GLIMMERVOID_CONFIG: 'C:\\x\\config.json',
  };
}

test('scrubs all 6 inherited vars', () => {
  const env = claudeSpawnEnv(fullBase());
  for (const k of SCRUBBED) {
    assert.ok(!(k in env), `${k} must be deleted from the spawn env`);
  }
});

test('negative: no CLAUDECODE-exact or GLIMMERVOID_* keys survive', () => {
  const env = claudeSpawnEnv(fullBase());
  const keys = Object.keys(env);
  assert.equal(keys.includes('CLAUDECODE'), false);
  assert.equal(keys.some((k) => k.startsWith('GLIMMERVOID_')), false);
  assert.equal(keys.includes('CLAUDE_CODE_SSE_PORT'), false);
  assert.equal(keys.includes('CLAUDE_CODE_ENTRYPOINT'), false);
});

const GUARDED_SESSION_ENV = {
  GLIMMERVOID_SANE_YOLO_PATH: '/session/cc-safety-net.js',
  CC_SAFETY_NET_HOME: '/session/sane-yolo',
  CC_SAFETY_NET_AUDIT_HOME: '/session/sane-yolo',
  CC_SAFETY_NET_AUDIT_SCOPE: 'blocked',
  CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY: '1',
};

test('the relay-arming paths never reach any session, guarded or not', () => {
  const inheritedRelayPaths = { GLIMMERVOID_RTK_PATH: '/parent/rtk', GLIMMERVOID_SANE_YOLO_PATH: '/parent/cc-safety-net.js' };
  const unguarded = claudeSpawnEnv({ ...fullBase(), ...inheritedRelayPaths });
  const guarded = claudeSpawnEnv({ ...fullBase(), ...inheritedRelayPaths }, { CC_SAFETY_NET_HOME: '/session/sane-yolo' });
  for (const key of Object.keys(inheritedRelayPaths)) {
    assert.equal(key in unguarded, false, `${key} must be scrubbed from an unguarded session`);
    assert.equal(key in guarded, false, `${key} must be scrubbed from a guarded session`);
  }
});

test("an unguarded session keeps the operator's own cc-safety-net configuration", () => {
  const env = claudeSpawnEnv({ ...fullBase(), CC_SAFETY_NET_HOME: '/operator/safety-net', SAFETY_NET_STRICT: '1' });
  assert.equal(env.CC_SAFETY_NET_HOME, '/operator/safety-net');
  assert.equal(env.SAFETY_NET_STRICT, '1');
});

test('a guarded session drops every inherited safety-net key and keeps its own values', () => {
  const inherited = {
    CC_SAFETY_NET_HOME: '/parent/sane-yolo',
    CC_SAFETY_NET_WORKTREE: '1',
    CC_SAFETY_NET_LEVEL: 'off',
    SAFETY_NET_WORKTREE: '1',
    SAFETY_NET_STRICT: '0',
    cc_safety_net_paranoid: '0',
  };
  const env = claudeSpawnEnv({ ...fullBase(), ...inherited }, GUARDED_SESSION_ENV);
  for (const key of ['CC_SAFETY_NET_WORKTREE', 'CC_SAFETY_NET_LEVEL', 'SAFETY_NET_WORKTREE', 'SAFETY_NET_STRICT', 'cc_safety_net_paranoid']) {
    assert.equal(key in env, false, `${key} must be scrubbed from a guarded session`);
  }
  for (const [key, value] of Object.entries(GUARDED_SESSION_ENV)) assert.equal(env[key], value, key);
});

test('preserves unrelated vars (including an inherited ANTHROPIC_BASE_URL)', () => {
  const env = claudeSpawnEnv({ ...fullBase(), ANTHROPIC_BASE_URL: 'http://user-proxy:9999' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://user-proxy:9999');
});

test('CLAUDE_CODE_NO_FLICKER is always set to "1"', () => {
  assert.equal(claudeSpawnEnv(fullBase()).CLAUDE_CODE_NO_FLICKER, '1');
});

test('returns a COPY - baseEnv is never mutated', () => {
  const base = fullBase();
  const env = claudeSpawnEnv(base);
  assert.notEqual(env, base, 'output must be a distinct object');
  assert.equal(base.CLAUDECODE, '1');
  assert.equal(base.GLIMMERVOID_PORT, '3000');
  assert.equal(base.CLAUDE_CODE_SSE_PORT, '7777');
  assert.ok(!('CLAUDE_CODE_NO_FLICKER' in base), 'flag must not leak back onto the source');
  assert.equal(env.CLAUDE_CODE_NO_FLICKER, '1', 'flag must be present on the output');
});

test('prependPathDir prepends to an existing Path key without adding PATH', () => {
  const base: SpawnEnv = { ...fullBase(), Path: `C:\\Windows${path.delimiter}C:\\Tools` };
  delete base.PATH;
  const env = claudeSpawnEnv(base, null, { prependPathDir: 'C:\\Users\\johnw\\.glimmervoid\\bin' });
  assert.equal(env.Path, `C:\\Users\\johnw\\.glimmervoid\\bin${path.delimiter}C:\\Windows${path.delimiter}C:\\Tools`);
  assert.equal('PATH' in env, false);
});

test('prependPathDir prepends to an existing PATH key', () => {
  const env = claudeSpawnEnv(fullBase(), null, { prependPathDir: '/home/u/.glimmervoid/bin' });
  assert.equal(env.PATH, `/home/u/.glimmervoid/bin${path.delimiter}/usr/bin`);
});

test('prependPathDir does not duplicate an existing path entry case-insensitively', () => {
  const existingPath = `C:\\Users\\johnw\\.glimmervoid\\bin${path.delimiter}C:\\Windows`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'c:\\users\\johnw\\.glimmervoid\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir does not duplicate an entry that differs only in slash direction', () => {
  const existingPath = `C:/Users/johnw/.glimmervoid/bin${path.delimiter}C:\\Windows`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'C:\\Users\\johnw\\.glimmervoid\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir keeps a Windows drive-letter entry whole in a colon-delimited PATH', () => {
  const existingPath = `/usr/bin${path.delimiter}C:\\Users\\johnw\\.glimmervoid\\bin`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: 'C:\\Users\\johnw\\.glimmervoid\\bin',
  });
  assert.equal(env.PATH, existingPath);
});

test('prependPathDir prepends ahead of a Windows drive-letter entry without splitting it', () => {
  const existingPath = `/usr/bin${path.delimiter}C:\\Windows\\bin`;
  const env = claudeSpawnEnv({ ...fullBase(), PATH: existingPath }, null, {
    prependPathDir: '/home/u/.glimmervoid/bin',
  });
  assert.equal(env.PATH, `/home/u/.glimmervoid/bin${path.delimiter}${existingPath}`);
});

test('prependPathDir sets PATH when no path variable exists', () => {
  const base = fullBase();
  delete base.PATH;
  const env = claudeSpawnEnv(base, null, { prependPathDir: '/home/u/.glimmervoid/bin' });
  assert.equal(env.PATH, '/home/u/.glimmervoid/bin');
});

test('omitted or null prependPathDir leaves the path variable byte-identical', () => {
  const base = fullBase();
  assert.equal(claudeSpawnEnv(base).PATH, base.PATH);
  assert.equal(claudeSpawnEnv(base, null, { prependPathDir: null }).PATH, base.PATH);
});

test('prependPathDirs keeps the first directory first ahead of the single rtk directory', () => {
  const prependPathDirs = ['/factory/bin', '/tools/bin'];
  const env = claudeSpawnEnv(fullBase(), null, { prependPathDir: '/rtk/bin', prependPathDirs });
  assert.equal(env.PATH, ['/factory/bin', '/tools/bin', '/rtk/bin', '/usr/bin'].join(path.delimiter));
  assert.deepEqual(prependPathDirs, ['/factory/bin', '/tools/bin']);
});

test('prependPathDirs deduplicates by case and slash direction while keeping first occurrences in order', () => {
  const existingPath = ['C:/Existing/bin', '/usr/bin'].join(path.delimiter);
  const base: SpawnEnv = { ...fullBase(), Path: existingPath };
  delete base.PATH;
  const env = claudeSpawnEnv(base, null, {
    prependPathDir: '/rtk/bin',
    prependPathDirs: ['C:\\Factory\\bin', '/tools/bin', 'c:/factory/bin', 'c:\\existing\\bin', '/RTK/bin'],
  });
  assert.equal(env.Path, ['C:\\Factory\\bin', '/tools/bin', '/rtk/bin', 'C:/Existing/bin', '/usr/bin'].join(path.delimiter));
  assert.equal('PATH' in env, false);
});

test('empty prependPathDirs preserves the existing single-directory behavior', () => {
  const base = fullBase();
  assert.deepEqual(claudeSpawnEnv(base, null, { prependPathDirs: [] }), claudeSpawnEnv(base));
  assert.deepEqual(claudeSpawnEnv(base, null, { prependPathDir: '/rtk/bin', prependPathDirs: [] }),
    claudeSpawnEnv(base, null, { prependPathDir: '/rtk/bin' }));
});

test('the launching terminal identity never reaches an agent running inside the dashboard terminal', () => {
  const launchedFromGhostty = { ...fullBase(), TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.3.1', TERM: 'xterm-256color' };
  for (const env of [claudeSpawnEnv(launchedFromGhostty), buildAgentEnv(launchedFromGhostty, null, {})]) {
    assert.equal('TERM_PROGRAM' in env, false);
    assert.equal('TERM_PROGRAM_VERSION' in env, false);
    assert.equal(env.TERM, 'xterm-256color');
  }
});

test('only Claude Code is told the dashboard terminal renders hyperlinks, so other agents never leak link escapes into piped output', () => {
  assert.equal(claudeSpawnEnv(fullBase()).FORCE_HYPERLINK, '1');
  assert.equal('FORCE_HYPERLINK' in buildAgentEnv(fullBase(), null, {}), false);
});

const GLIMMERVOID_SECRET_ENV_NAMES = [...ENV_SECRET_BINDINGS.map((binding) => binding.environmentVariable), OVERRIDE_TOKEN_ENV];
const GLIMMERVOID_SECRETS = Object.fromEntries(GLIMMERVOID_SECRET_ENV_NAMES.map((secretKey) => [secretKey, `${secretKey}-value`]));

test('Glimmervoid secrets never reach any agent session env', () => {
  const inherited = { ...fullBase(), ...GLIMMERVOID_SECRETS };
  for (const env of [claudeSpawnEnv(inherited), buildAgentEnv(inherited, null, {})]) {
    for (const secretKey of Object.keys(GLIMMERVOID_SECRETS)) assert.equal(secretKey in env, false, `${secretKey} must be scrubbed`);
  }
});

test('a lane that deliberately sets a Glimmervoid secret key in extraEnv still wins over the scrub', () => {
  const env = buildAgentEnv({ ...fullBase(), ...GLIMMERVOID_SECRETS }, { GLIMMERVOID_CLAUDE_OAUTH_TOKEN: '' }, {});
  assert.equal(env.GLIMMERVOID_CLAUDE_OAUTH_TOKEN, '');
  assert.equal('GLIMMERVOID_POSTHOG_API_KEY' in env, false);
});

test('an explicitly configured TERM_PROGRAM still reaches the agent', () => {
  const env = claudeSpawnEnv({ ...fullBase(), TERM_PROGRAM: 'ghostty' }, { TERM_PROGRAM: 'custom' });
  assert.equal(env.TERM_PROGRAM, 'custom');
});

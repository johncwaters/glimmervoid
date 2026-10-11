import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildRtkHookEntry,
  HOOK_TOOLS,
  mergeCodexPreToolUse,
  resolveRtkPath,
} from '../session/core/hook-tools.ts';
import type { StatApi } from '../session/core/hook-tools.ts';
import { getRtkPath, resetRtkPathCache } from '../server/rtk-resolver.ts';
import { resolveRequiredSaneYoloHookTools } from '../server/hook-tools.ts';
import { MAX_RTK_STDOUT_BYTES, normalizeRtkHookResponse } from '../session/core/rtk-hook-core.ts';

function fsWithFiles(files: string[]): StatApi {
  const normalized = new Set(files.map((file) => path.resolve(file)));
  return {
    statSync(candidate: string) {
      const resolved = path.resolve(candidate);
      if (!normalized.has(resolved)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
  };
}

test('buildRtkHookEntry emits a forward-slash hook command without quoting a plain path', () => {
  assert.deepEqual(buildRtkHookEntry('C:\\tools\\rtk.exe'), {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'C:/tools/rtk.exe hook claude' }],
  });
});

test('buildRtkHookEntry quotes a forward-slash hook command containing spaces', () => {
  assert.deepEqual(buildRtkHookEntry('C:\\Program Files\\rtk\\rtk.exe'), {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: '"C:/Program Files/rtk/rtk.exe" hook claude' }],
  });
});

test('resolveRtkPath prefers the Glimmervoid managed bin directory before PATH', () => {
  const glimmervoidHome = path.join('C:\\Users', 'johnw', '.glimmervoid');
  const bundled = path.join(glimmervoidHome, 'bin', 'rtk.exe');
  const resolved = resolveRtkPath({
    glimmervoidHome,
    platform: 'win32',
    fsApi: fsWithFiles([bundled]),
    exec: () => {
      throw new Error('PATH should not be queried');
    },
  });
  assert.equal(resolved, path.resolve(bundled));
});

test('resolveRtkPath probes extensionless Glimmervoid bin candidate for non-Windows installs', () => {
  const glimmervoidHome = '/home/jw/.glimmervoid';
  const bundled = path.join(glimmervoidHome, 'bin', 'rtk');
  const resolved = resolveRtkPath({
    glimmervoidHome,
    platform: 'linux',
    fsApi: fsWithFiles([bundled]),
    exec: () => {
      throw new Error('PATH should not be queried');
    },
  });
  assert.equal(resolved, path.resolve(bundled));
});

test('resolveRtkPath falls back to the first PATH match', () => {
  const resolved = resolveRtkPath({
    glimmervoidHome: 'C:\\Users\\johnw\\.glimmervoid',
    platform: 'win32',
    fsApi: fsWithFiles([]),
    exec: () => 'C:\\tools\\rtk.exe\r\nC:\\other\\rtk.exe\r\n',
  });
  assert.equal(resolved, path.resolve('C:\\tools\\rtk.exe'));
});

test('resolveRtkPath falls back to command -v when which is missing on posix', () => {
  const commands: string[] = [];
  const resolved = resolveRtkPath({
    glimmervoidHome: '/home/jw/.glimmervoid',
    platform: 'linux',
    fsApi: fsWithFiles([]),
    exec(command: string) {
      commands.push(command);
      if (command === 'which -a rtk') throw new Error('which missing');
      assert.equal(command, 'sh -c "command -v rtk"');
      return '/home/jw/.local/bin/rtk\n';
    },
  });

  assert.deepEqual(commands, ['which -a rtk', 'sh -c "command -v rtk"']);
  assert.equal(resolved, path.resolve('/home/jw/.local/bin/rtk'));
});

test('resolveRtkPath falls back to command -v when which returns no matches', () => {
  const commands: string[] = [];
  const resolved = resolveRtkPath({
    glimmervoidHome: '/home/jw/.glimmervoid',
    platform: 'linux',
    fsApi: fsWithFiles([]),
    exec(command: string) {
      commands.push(command);
      if (command === 'which -a rtk') return '\n';
      return '/usr/local/bin/rtk\n';
    },
  });

  assert.deepEqual(commands, ['which -a rtk', 'sh -c "command -v rtk"']);
  assert.equal(resolved, path.resolve('/usr/local/bin/rtk'));
});

test('resolveRtkPath returns null when neither managed bin nor PATH resolves', () => {
  const resolved = resolveRtkPath({
    glimmervoidHome: 'C:\\Users\\johnw\\.glimmervoid',
    platform: 'win32',
    fsApi: fsWithFiles([]),
    exec: () => {
      throw new Error('not found');
    },
  });
  assert.equal(resolved, null);
});

test('the RTK resolution cache has an explicit invalidation path', () => {
  let calls = 0;
  resetRtkPathCache();
  assert.equal(getRtkPath(() => {
    calls += 1;
    return '/first/rtk';
  }), '/first/rtk');
  assert.equal(getRtkPath(() => {
    calls += 1;
    return '/ignored/rtk';
  }), '/first/rtk');
  assert.equal(calls, 1);
  resetRtkPathCache();
  assert.equal(getRtkPath(() => {
    calls += 1;
    return '/second/rtk';
  }), '/second/rtk');
  assert.equal(calls, 2);
  resetRtkPathCache();
});

test('a rewrite missing permissionDecision is completed with allow', () => {
  const raw = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecisionReason: 'RTK auto-rewrite',
      updatedInput: { command: 'rtk git log --oneline -3' },
    },
  });
  const normalized = JSON.parse(normalizeRtkHookResponse(`${raw}\n`));
  assert.equal(normalized.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(normalized.hookSpecificOutput.updatedInput, { command: 'rtk git log --oneline -3' });
  assert.equal(normalized.hookSpecificOutput.permissionDecisionReason, 'RTK auto-rewrite');
});

test('an explicit decision is never rewritten, whatever it says', () => {
  for (const permissionDecision of ['allow', 'deny', 'ask']) {
    const raw = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, updatedInput: { command: 'rtk ls -la' } },
    });
    assert.equal(JSON.parse(normalizeRtkHookResponse(raw)).hookSpecificOutput.permissionDecision, permissionDecision);
  }
});

test('a verdict carrying no updatedInput passes through without gaining a decision', () => {
  const raw = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  const normalized = JSON.parse(normalizeRtkHookResponse(raw));
  assert.equal('permissionDecision' in normalized.hookSpecificOutput, false);
});

test('anything unusable normalizes to the empty response, which leaves the tool call alone', () => {
  for (const unusable of ['', '   ', '\n', 'not json', '{"a":', '[]', 'null', '"text"', '42', undefined, null, 7]) {
    assert.equal(normalizeRtkHookResponse(unusable), '', String(unusable));
  }
});

test('an oversize verdict is refused rather than forwarded', () => {
  const padded = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'x'.repeat(MAX_RTK_STDOUT_BYTES) } },
  });
  assert.equal(normalizeRtkHookResponse(padded), '');
});

test('Sane YOLO runs node from PATH with the quoted bin path and preserves the tool matcher', () => {
  assert.deepEqual(HOOK_TOOLS.saneYolo.claudeEntry({ id: 'saneYolo', binPath: 'C:\\Program Files\\guard.js' }), {
    matcher: 'Bash|PowerShell|Monitor',
    hooks: [{ type: 'command', command: 'node "C:/Program Files/guard.js" hook --coding-cli' }],
  });
});

test('Codex merges the two tools under one override and rejects unsafe paths', () => {
  const rtk = HOOK_TOOLS.rtk.codexGroup({ id: 'rtk', binPath: '/bin/rtk' }, '/g/hook-tool-relay.js');
  const guard = HOOK_TOOLS.saneYolo.codexGroup({ id: 'saneYolo', binPath: '/g/guard.js' }, '/unused');
  assert.ok(rtk);
  assert.ok(guard);
  assert.deepEqual(mergeCodexPreToolUse([rtk, guard]), ['-c', `hooks.PreToolUse=[${rtk},${guard}]`]);
  assert.deepEqual(mergeCodexPreToolUse([]), []);
  assert.equal(HOOK_TOOLS.saneYolo.codexGroup({ id: 'saneYolo', binPath: '/$(id)/guard.js' }, '/unused'), null);
});

test('hook tool environments keep the guard policy and blocked audit logs together', () => {
  assert.deepEqual(HOOK_TOOLS.saneYolo.env({ id: 'saneYolo', binPath: '/g/guard.js' }, '/g/policy'), {
    GLIMMERVOID_SANE_YOLO_PATH: '/g/guard.js',
    CC_SAFETY_NET_HOME: '/g/policy',
    CC_SAFETY_NET_AUDIT_HOME: '/g/policy',
    CC_SAFETY_NET_AUDIT_SCOPE: 'blocked',
    CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY: '1',
  });
});

test('required Sane YOLO resolves as if skipping permissions with the hook forced on and keeps rtk', () => {
  const calls: unknown[] = [];
  const saneYoloTools = [{ id: 'rtk' as const, binPath: '/rtk' }, { id: 'saneYolo' as const, binPath: '/cc-safety-net' }];
  const resolved = resolveRequiredSaneYoloHookTools({ rtk: true }, { resolve: (config, options) => { calls.push({ config, options }); return saneYoloTools; } });
  assert.deepEqual(resolved, saneYoloTools);
  assert.deepEqual(calls, [{ config: { rtk: true, saneYolo: true }, options: { skipPermissions: true } }]);
});

test('required Sane YOLO is null when cc-safety-net does not resolve', () => {
  assert.equal(resolveRequiredSaneYoloHookTools({}, { resolve: () => [{ id: 'rtk', binPath: '/rtk' }] }), null);
  assert.equal(resolveRequiredSaneYoloHookTools({}, { resolve: () => [] }), null);
});

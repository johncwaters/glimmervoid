import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POSTHOG_PROJECT_TOKEN, adapterBucket, buildExceptionProperties, classifySessionExit, decideTelemetryConsent,
  nodeMajorVersion, parseV8StackFrames, resolveProjectToken, scrubLocalPath,
} from '../server/core/telemetry-core.ts';
import { TELEMETRY_EVENT_SCHEMAS, TELEMETRY_EVENTS } from '../shared/contracts/telemetry.ts';
import type { TelemetryEventName } from '../shared/contracts/telemetry.ts';

const POSIX_PACKAGE_ROOT = '/home/alice/.npm-global/lib/node_modules/glimmervoid';
const WINDOWS_PACKAGE_ROOT = 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\glimmervoid';

const CONSENT_PRECEDENCE: Array<{ env: Record<string, string>; enabled?: boolean; expected: { isEnabled: boolean; source: string } }> = [
  { env: {}, expected: { isEnabled: true, source: 'default' } },
  { env: {}, enabled: true, expected: { isEnabled: true, source: 'config' } },
  { env: {}, enabled: false, expected: { isEnabled: false, source: 'config' } },
  { env: { DO_NOT_TRACK: '1' }, enabled: true, expected: { isEnabled: false, source: 'do-not-track' } },
  { env: { GLIMMERVOID_TELEMETRY: '0' }, enabled: true, expected: { isEnabled: false, source: 'environment' } },
  { env: { CI: 'true' }, enabled: true, expected: { isEnabled: false, source: 'ci' } },
  { env: { DO_NOT_TRACK: '1', GLIMMERVOID_TELEMETRY: '0', CI: 'true' }, enabled: true, expected: { isEnabled: false, source: 'do-not-track' } },
  { env: { GLIMMERVOID_TELEMETRY: '0', CI: 'true' }, expected: { isEnabled: false, source: 'environment' } },
  { env: { DO_NOT_TRACK: '0', GLIMMERVOID_TELEMETRY: '1', CI: 'false' }, expected: { isEnabled: true, source: 'default' } },
  { env: { GLIMMERVOID_TELEMETRY: '1' }, enabled: false, expected: { isEnabled: false, source: 'config' } },
];

test('consent follows DO_NOT_TRACK, then GLIMMERVOID_TELEMETRY, then CI, then config, then on by default', () => {
  for (const row of CONSENT_PRECEDENCE) {
    const config = row.enabled === undefined ? {} : { telemetry: { enabled: row.enabled } };
    assert.deepEqual(decideTelemetryConsent(row.env, config), row.expected, JSON.stringify(row));
  }
});

test('the project token comes from the constant unless the environment overrides it', () => {
  assert.equal(resolveProjectToken({}), POSTHOG_PROJECT_TOKEN);
  assert.equal(resolveProjectToken({ GLIMMERVOID_TELEMETRY_PROJECT_TOKEN: '  ' }), POSTHOG_PROJECT_TOKEN);
  assert.equal(resolveProjectToken({ GLIMMERVOID_TELEMETRY_PROJECT_TOKEN: 'phc_scratch' }), 'phc_scratch');
});

test('a local path keeps only its package-relative, dependency-relative or base name', () => {
  assert.equal(scrubLocalPath(`${POSIX_PACKAGE_ROOT}/dist/server/main.js`, POSIX_PACKAGE_ROOT), 'dist/server/main.js');
  assert.equal(scrubLocalPath(`file://${POSIX_PACKAGE_ROOT}/server/main.ts`, POSIX_PACKAGE_ROOT), 'server/main.ts');
  assert.equal(scrubLocalPath('/home/alice/projects/secret/tool.js', POSIX_PACKAGE_ROOT), 'tool.js');
  assert.equal(scrubLocalPath('/home/alice/elsewhere/node_modules/ws/lib/websocket.js', POSIX_PACKAGE_ROOT), 'node_modules/ws/lib/websocket.js');
  assert.equal(scrubLocalPath('node:internal/modules/cjs/loader', POSIX_PACKAGE_ROOT), 'node:internal/modules/cjs/loader');
  assert.equal(scrubLocalPath('file:///home/alice/my%20code/x.js', POSIX_PACKAGE_ROOT), 'x.js');
});

test('Windows drive paths are scrubbed whatever their slash direction or letter case', () => {
  assert.equal(scrubLocalPath(`${WINDOWS_PACKAGE_ROOT}\\dist\\server\\main.js`, WINDOWS_PACKAGE_ROOT), 'dist/server/main.js');
  assert.equal(scrubLocalPath('c:\\users\\alice\\code\\x.js', WINDOWS_PACKAGE_ROOT), 'x.js');
  assert.equal(scrubLocalPath('file:///C:/Users/Alice/code/x.js', WINDOWS_PACKAGE_ROOT), 'x.js');
});

const IDENTIFYING_MESSAGE_FRAGMENTS = [
  'https://x-access-token:ghp_abc123@github.com/acme/secret-repo.git',
  '/home/alice/projects/secret repo/.env',
  'file:///home/alice/my%20code/x.js',
  'refs/heads/alice/secret-feature',
];

function errorWithCode(message: string, code: unknown): Error {
  return Object.assign(new Error(message), { code });
}

test('exception properties never carry any part of the error message', () => {
  const message = `push failed for ${IDENTIFYING_MESSAGE_FRAGMENTS.join(' and ')}`;
  for (const error of [new Error(message), errorWithCode(message, 'ENOENT'), errorWithCode(message, message), message]) {
    const serialized = JSON.stringify(buildExceptionProperties(error, { handled: true, packageRoot: POSIX_PACKAGE_ROOT }));
    for (const fragment of [...IDENTIFYING_MESSAGE_FRAGMENTS, 'secret', 'alice', 'push failed']) {
      assert.equal(serialized.includes(fragment), false, `${fragment} leaked into ${serialized}`);
    }
  }
});

test('exception value keeps only a constant-shaped error code', () => {
  const valueFor = (error: unknown) => buildExceptionProperties(error, { handled: true, packageRoot: POSIX_PACKAGE_ROOT }).$exception_list[0].value;
  assert.equal(valueFor(errorWithCode('open /home/alice/.env', 'ENOENT')), 'ENOENT');
  assert.equal(valueFor(errorWithCode('x', 'ERR_MODULE_NOT_FOUND')), 'ERR_MODULE_NOT_FOUND');
  assert.equal(valueFor(errorWithCode('x', 'enoent')), '');
  assert.equal(valueFor(errorWithCode('x', 42)), '');
  assert.equal(valueFor(new Error('no code')), '');
});

const SAMPLE_STACK = [
  'TypeError: boom',
  `    at startAgentSession (${POSIX_PACKAGE_ROOT}/dist/server/main.js:10:5)`,
  '    at async Promise.all (index 0)',
  `    at Object.<anonymous> (${POSIX_PACKAGE_ROOT}/node_modules/ws/lib/websocket.js:3:7)`,
  '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
  `    at file://${POSIX_PACKAGE_ROOT}/dist/server/index.js:2:1`,
  '    at /home/alice/other/thing.js:4:2',
].join('\n');

test('V8 frames parse outermost first with scrubbed filenames and in_app only for app code', () => {
  assert.deepEqual(parseV8StackFrames(SAMPLE_STACK, POSIX_PACKAGE_ROOT), [
    { platform: 'node:javascript', function: '?', filename: 'thing.js', lineno: 4, colno: 2, in_app: false },
    { platform: 'node:javascript', function: '?', filename: 'dist/server/index.js', lineno: 2, colno: 1, in_app: true },
    { platform: 'node:javascript', function: 'Module._compile', filename: 'node:internal/modules/cjs/loader', lineno: 1554, colno: 14, in_app: false },
    { platform: 'node:javascript', function: 'Object.<anonymous>', filename: 'node_modules/ws/lib/websocket.js', lineno: 3, colno: 7, in_app: false },
    { platform: 'node:javascript', function: 'startAgentSession', filename: 'dist/server/main.js', lineno: 10, colno: 5, in_app: true },
  ]);
});

test('a deep stack is capped at 64 frames, keeping the innermost', () => {
  const lines = ['Error: deep'];
  for (let depth = 0; depth < 200; depth += 1) lines.push(`    at frame${depth} (${POSIX_PACKAGE_ROOT}/server/x.ts:${depth + 1}:1)`);
  const frames = parseV8StackFrames(lines.join('\n'), POSIX_PACKAGE_ROOT);
  assert.equal(frames.length, 64);
  assert.equal(frames.at(-1)?.function, 'frame0');
});

test('exception properties carry the handled mechanism and level, and satisfy the allowlist', () => {
  const error = new TypeError(`cannot read /home/alice/projects/secret/config.json`);
  error.stack = SAMPLE_STACK;
  const handled = buildExceptionProperties(error, { handled: true, packageRoot: POSIX_PACKAGE_ROOT });
  assert.equal(handled.$exception_level, 'error');
  assert.equal(handled.$exception_list[0].type, 'TypeError');
  assert.equal(handled.$exception_list[0].value, '');
  assert.deepEqual(handled.$exception_list[0].mechanism, { handled: true, synthetic: false, type: 'generic' });
  assert.equal(TELEMETRY_EVENT_SCHEMAS.$exception.safeParse(handled).success, true);
  assert.equal(JSON.stringify(handled).includes('/home/'), false);
  const fatal = buildExceptionProperties('a thrown string', { handled: false, packageRoot: POSIX_PACKAGE_ROOT });
  assert.equal(fatal.$exception_level, 'fatal');
  assert.equal(fatal.$exception_list[0].type, 'NonError');
  assert.deepEqual(fatal.$exception_list[0].stacktrace.frames, []);
});

test('every event schema refuses a property outside its allowlist', () => {
  const validByEvent = {
    app_started: {},
    app_active: { active_session_count: 2 },
    session_started: { adapter: 'codex' },
    session_ended: { adapter: 'custom', exit_kind: 'clean', duration_seconds: 30 },
    $exception: buildExceptionProperties(new Error('x'), { handled: true, packageRoot: POSIX_PACKAGE_ROOT }),
    $ai_generation: {
      $ai_trace_id: 'a'.repeat(64), $ai_provider: 'anthropic', $ai_model: 'claude-opus-5-5',
      $ai_input_tokens: 10, $ai_output_tokens: 5, $ai_total_cost_usd: 0.01, agent_adapter: 'claude-code',
    },
  };
  const everyEventName: TelemetryEventName[] = [...TELEMETRY_EVENTS.map(({ name }) => name), '$exception', '$ai_generation'];
  for (const name of everyEventName) {
    const schema = TELEMETRY_EVENT_SCHEMAS[name];
    assert.equal(schema.safeParse(validByEvent[name]).success, true, `${name} accepts its allowlist`);
    assert.equal(schema.safeParse({ ...validByEvent[name], cwd: '/home/alice/repo' }).success, false, `${name} refuses an extra property`);
  }
  assert.equal(TELEMETRY_EVENT_SCHEMAS.session_started.safeParse({ adapter: 'my-agent' }).success, false);
});

test('a custom agent id is reported only as custom', () => {
  assert.equal(adapterBucket('claude-code'), 'claude-code');
  assert.equal(adapterBucket('codex'), 'codex');
  assert.equal(adapterBucket('grok'), 'grok');
  assert.equal(adapterBucket('acme-internal-agent'), 'custom');
  assert.equal(adapterBucket(null), 'custom');
});

test('a session exit is classified as no output, clean, signal or error', () => {
  assert.equal(classifySessionExit({ exitCode: 1, signal: 0, reason: 'no_output_before_exit' }), 'no_output');
  assert.equal(classifySessionExit({ exitCode: 0, signal: 0 }), 'clean');
  assert.equal(classifySessionExit({ exitCode: null, signal: 15 }), 'signal');
  assert.equal(classifySessionExit({ exitCode: 0, signal: 15 }), 'signal');
  assert.equal(classifySessionExit({ exitCode: 2, signal: 0 }), 'error');
});

test('the node major version parses from a version string', () => {
  assert.equal(nodeMajorVersion('24.3.0'), 24);
  assert.equal(nodeMajorVersion('v22.18.0'), 22);
  assert.equal(nodeMajorVersion('nonsense'), 0);
});

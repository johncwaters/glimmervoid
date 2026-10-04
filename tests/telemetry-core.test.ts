import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POSTHOG_PROJECT_TOKEN, adapterBucket, buildAiGenerationEvents, buildBrowserExceptionProperties, buildExceptionProperties,
  classifySessionExit, decideIsDevInstall, decideRemoteTelemetryState, decideTelemetryConsent, exceptionFingerprint, isTelemetryForcedOff, nodeMajorVersion, parseBrowserStackFrames, parseV8StackFrames,
  parsePosthogReleaseId, resolveProjectToken, scrubLocalPath, urlPathOnly,
} from '../server/core/telemetry-core.ts';
import { AiGenerationProperties, TELEMETRY_EVENT_SCHEMAS, TELEMETRY_EVENTS } from '../shared/contracts/telemetry.ts';
import type { UsageGenerationRollupRow } from '../server/core/usage-entry-core.ts';
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
  { env: { NODE_TEST_CONTEXT: 'child-v8' }, enabled: true, expected: { isEnabled: false, source: 'test-runner' } },
  { env: { NODE_TEST_CONTEXT: 'child-v8' }, expected: { isEnabled: false, source: 'test-runner' } },
  { env: { CI: 'true', NODE_TEST_CONTEXT: 'child-v8' }, enabled: true, expected: { isEnabled: false, source: 'ci' } },
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
  const everyEventName: TelemetryEventName[] = TELEMETRY_EVENTS.map(({ name }) => name);
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

test('a browser frame URL keeps only its path, and a non-web URL only its file name', () => {
  assert.equal(urlPathOnly('https://alice:secret@localhost:4400/assets/app.js?v=1#top'), '/assets/app.js');
  assert.equal(urlPathOnly('http://127.0.0.1:5173/public/app.ts'), '/public/app.ts');
  assert.equal(urlPathOnly('http://localhost:4400'), '/');
  assert.equal(urlPathOnly('file:///home/alice/repo/page.js'), 'page.js');
  assert.equal(urlPathOnly('chrome-extension://abc/content.js?x=1'), 'content.js');
});

test('a Vite dev-server /@fs/ or node_modules frame URL never keeps the local checkout path', () => {
  assert.equal(urlPathOnly('http://localhost:5173/@fs/home/alice/checkout/shared/x.ts?t=1'), 'x.ts');
  assert.equal(urlPathOnly('http://localhost:5173/@fs/home/alice/checkout/node_modules/@xterm/xterm/lib/xterm.js'), 'node_modules/@xterm/xterm/lib/xterm.js');
  assert.equal(urlPathOnly('http://localhost:5173/node_modules/.vite/deps/zod.js'), 'node_modules/.vite/deps/zod.js');
  const properties = buildBrowserExceptionProperties({
    name: 'TypeError',
    stack: '    at parse (http://localhost:5173/@fs/home/alice/checkout/shared/contracts/x.ts:3:9)\nload@http://localhost:5173/@fs/home/alice/checkout/node_modules/ws/index.js:1:1',
  });
  const payload = JSON.stringify(properties);
  assert.equal(payload.includes('alice'), false);
  assert.equal(payload.includes('/home/'), false);
});

test('browser frames parse from V8 and Gecko stacks outermost first, in_app only for web URLs', () => {
  const chromeFrames = parseBrowserStackFrames('    at render (http://localhost/assets/app.js:10:5)\n    at http://localhost/assets/vendor.js:2:1');
  assert.deepEqual(chromeFrames.map((frame) => [frame.platform, frame.function, frame.filename, frame.lineno, frame.colno, frame.in_app]), [
    ['web:javascript', '?', '/assets/vendor.js', 2, 1, true],
    ['web:javascript', 'render', '/assets/app.js', 10, 5, true],
  ]);
  const geckoFrames = parseBrowserStackFrames('render@http://localhost/assets/app.js:10:5\n@moz-extension://abc/inject.js:1:1');
  assert.deepEqual(geckoFrames.map((frame) => [frame.function, frame.filename, frame.in_app]), [
    ['?', 'inject.js', false],
    ['render', '/assets/app.js', true],
  ]);
});

test('a browser exception keeps a safe type name, no value, and is unhandled at error level', () => {
  const properties = buildBrowserExceptionProperties({ name: 'secret /home/alice name', stack: '' });
  assert.equal(properties.$exception_list[0].type, 'Error');
  assert.equal(properties.$exception_list[0].value, '');
  assert.equal(properties.$exception_list[0].mechanism.handled, false);
  assert.equal(properties.$exception_level, 'error');
  assert.equal(TELEMETRY_EVENT_SCHEMAS.$exception.safeParse(properties).success, true);
});

test('the exception fingerprint is the type plus in-app frames and ignores the message and dependency frames', () => {
  const stackFor = (message: string, dependencyFile: string) => {
    const error = new TypeError(message);
    error.stack = `TypeError: ${message}\n    at run (${POSIX_PACKAGE_ROOT}/server/a.ts:1:1)\n    at ${POSIX_PACKAGE_ROOT}/node_modules/${dependencyFile}:3:3`;
    return buildExceptionProperties(error, { handled: true, packageRoot: POSIX_PACKAGE_ROOT });
  };
  assert.equal(exceptionFingerprint(stackFor('one', 'ws/a.js')), exceptionFingerprint(stackFor('two', 'ws/b.js')));
  assert.equal(exceptionFingerprint(stackFor('one', 'ws/a.js')), 'TypeError|run@server/a.ts');
});

function generationRow(overrides: Partial<UsageGenerationRollupRow> = {}): UsageGenerationRollupRow {
  return {
    sessionId: 'session-secret-a',
    model: 'claude-sonnet-4-20250514',
    vendor: 'claude',
    input: 100,
    output: 20,
    cacheRead: 300,
    cacheCreate: 40,
    costUSD: 0.25,
    hasKnownCost: true,
    isModelKnown: true,
    ...overrides,
  };
}

test('ai generation events validate against the allowlist and never carry the session id', () => {
  const installId = '2f1c7c1e-9d7a-4c55-9a51-0e8d1d1b8a01';
  const events = buildAiGenerationEvents([
    generationRow(),
    generationRow({ vendor: 'codex', model: 'gpt-5.6', hasKnownCost: false, costUSD: 0 }),
    generationRow({ vendor: 'grok', model: 'grok-4' }),
    generationRow({ vendor: 'my-vendor', model: 'local-model' }),
  ], installId);
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(AiGenerationProperties.safeParse(event).success, true);
    assert.equal(JSON.stringify(event).includes('session-secret-a'), false);
    assert.equal('$ai_input' in event, false);
    assert.equal('$ai_output' in event, false);
  }
  assert.deepEqual(events.map((event) => event.$ai_provider), ['anthropic', 'openai', 'xai', 'my-vendor']);
  assert.deepEqual(events.map((event) => event.agent_adapter), ['claude-code', 'codex', 'grok', 'custom']);
  assert.equal(events[0].$ai_total_cost_usd, 0.25);
  assert.equal('$ai_total_cost_usd' in events[1], false);
  assert.equal(events[0].$ai_input_tokens, 100);
  assert.equal(events[0].$ai_cache_read_input_tokens, 300);
});

test('ai generation trace ids are stable per install and session and differ across installs', () => {
  const [first] = buildAiGenerationEvents([generationRow()], 'install-a');
  const [again] = buildAiGenerationEvents([generationRow({ model: 'claude-opus-4' })], 'install-a');
  const [otherInstall] = buildAiGenerationEvents([generationRow()], 'install-b');
  assert.match(first.$ai_trace_id, /^[0-9a-f]{64}$/);
  assert.equal(first.$ai_trace_id, again.$ai_trace_id);
  assert.notEqual(first.$ai_trace_id, otherInstall.$ai_trace_id);
});

test('ai generation events send a known model name and replace an unknown one with unknown', () => {
  const bedrockArn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';
  const [known, unknown] = buildAiGenerationEvents([
    generationRow(),
    generationRow({ model: bedrockArn, isModelKnown: false }),
  ], 'install-a');
  assert.equal(known.$ai_model, 'claude-sonnet-4-20250514');
  assert.equal(unknown.$ai_model, 'unknown');
  assert.equal(JSON.stringify(unknown).includes('123456789012'), false);
});

test('ai generation rows with zero tokens are skipped', () => {
  const events = buildAiGenerationEvents([generationRow({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })], 'install-a');
  assert.deepEqual(events, []);
});

test('telemetry counts as forced off only by DO_NOT_TRACK, GLIMMERVOID_TELEMETRY=0 or CI, never by config', () => {
  assert.equal(isTelemetryForcedOff({}), false);
  assert.equal(isTelemetryForcedOff({ DO_NOT_TRACK: '1' }), true);
  assert.equal(isTelemetryForcedOff({ GLIMMERVOID_TELEMETRY: '0' }), true);
  assert.equal(isTelemetryForcedOff({ CI: 'true' }), true);
});

test('an install counts as dev for a clone, a source checkout or a non-default Glimmervoid home', () => {
  const published = { installFlavor: 'npm-global', isBundled: true, homeDir: '/home/alice/.glimmervoid', defaultHomeDir: '/home/alice/.glimmervoid' };
  assert.equal(decideIsDevInstall(published), false);
  assert.equal(decideIsDevInstall({ ...published, homeDir: '/home/alice/.glimmervoid/' }), false);
  assert.equal(decideIsDevInstall({ ...published, installFlavor: 'clone' }), true);
  assert.equal(decideIsDevInstall({ ...published, isBundled: false }), true);
  assert.equal(decideIsDevInstall({ ...published, homeDir: '/tmp/glimmervoid-scratch' }), true);
  assert.equal(decideIsDevInstall({
    ...published, homeDir: 'c:/Users/Alice/.glimmervoid', defaultHomeDir: 'C:\\Users\\Alice\\.glimmervoid',
  }), false);
});

test('a release id is kept only when it is a non-empty id-shaped string', () => {
  assert.equal(parsePosthogReleaseId('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'), '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
  assert.equal(parsePosthogReleaseId(''), null);
  assert.equal(parsePosthogReleaseId(undefined), null);
  assert.equal(parsePosthogReleaseId(42), null);
  assert.equal(parsePosthogReleaseId('id with spaces'), null);
  assert.equal(parsePosthogReleaseId('-leading-dash'), null);
  assert.equal(parsePosthogReleaseId('a'.repeat(129)), null);
});

const KILL_SWITCH_CASES: Array<{ name: string; previous: 'enabled' | 'disabled'; response: unknown; expected: 'enabled' | 'disabled' }> = [
  { name: 'explicitly disabled flag disables', previous: 'enabled', response: { flags: { 'telemetry-enabled': { key: 'telemetry-enabled', enabled: false } } }, expected: 'disabled' },
  { name: 'enabled flag re-enables', previous: 'disabled', response: { flags: { 'telemetry-enabled': { key: 'telemetry-enabled', enabled: true, reason: { code: 'condition_match' } } }, requestId: 'r' }, expected: 'enabled' },
  { name: 'missing flag keeps enabled', previous: 'enabled', response: { flags: {}, errorsWhileComputingFlags: false }, expected: 'enabled' },
  { name: 'missing flag keeps disabled', previous: 'disabled', response: { flags: { other: { enabled: false } } }, expected: 'disabled' },
  { name: 'errors while computing keep the previous state', previous: 'enabled', response: { flags: { 'telemetry-enabled': { enabled: false } }, errorsWhileComputingFlags: true }, expected: 'enabled' },
  { name: 'no response keeps the previous state', previous: 'enabled', response: null, expected: 'enabled' },
  { name: 'a malformed flag keeps the previous state', previous: 'enabled', response: { flags: { 'telemetry-enabled': { enabled: 'false' } } }, expected: 'enabled' },
  { name: 'a v1 shaped response keeps the previous state', previous: 'enabled', response: { featureFlags: { 'telemetry-enabled': false } }, expected: 'enabled' },
];

for (const killSwitchCase of KILL_SWITCH_CASES) {
  test(`remote kill switch: ${killSwitchCase.name}`, () => {
    assert.equal(decideRemoteTelemetryState(killSwitchCase.previous, killSwitchCase.response), killSwitchCase.expected);
  });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  classifyClaudeStartup, compressTimeline, findHookEndpoint, hasRunSettled, isRecordingClosed, parseCaptureRecording, redactRecording, redactSameLength, validateManifest, validateRecordManifest,
} from '../test/site-capture/manifest-core.ts';

const fixtureDirectory = path.resolve(import.meta.dirname, '../test/site-capture/fixtures');
const sampleManifest: unknown = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'sample-manifest.json'), 'utf8'));
const demoRecordManifest: unknown = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'demo-record.json'), 'utf8'));
const demoCaptureManifest: unknown = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'demo-capture.json'), 'utf8'));

test('capture manifest defaults replay settings and patch event', () => {
  const manifest = validateManifest({ viewport: { width: 1280, height: 800 }, sessions: [{ name: 'Capture', project: 'demo', recording: 'capture.jsonl' }], videoMs: 1000 });
  assert.equal(manifest.speed, 1);
  assert.equal(manifest.maxIdleGapMs, 2500);
  assert.deepEqual(manifest.redactions, []);
  assert.equal(manifest.sessions[0]?.patchAtEvent, 'Stop');
});

test('sample manifest and synthetic recording stay executable', () => {
  const manifest = validateManifest(sampleManifest);
  assert.equal(manifest.sessions.length, 3);
  for (const session of manifest.sessions) {
    const records = parseCaptureRecording(fs.readFileSync(path.join(fixtureDirectory, session.recording), 'utf8'));
    assert.deepEqual(records.filter((record) => record.type === 'hook').map((record) => record.event), ['UserPromptSubmit', 'Notification', 'Stop']);
    assert.ok(records.some((record) => record.type === 'resize'));
    if (session.patch) assert.ok(fs.existsSync(path.join(fixtureDirectory, session.patch)));
  }
});

test('timeline preserves relative spacing, simultaneous events and long idle gap caps after speed scaling', () => {
  const records = [{ ts: 1000 }, { ts: 1200 }, { ts: 1200 }, { ts: 20_000 }, { ts: 20_400 }];
  const timeline = compressTimeline(records, 2, 2500);
  assert.deepEqual(timeline.map((entry) => entry.atMs), [0, 100, 100, 2600, 2800]);
  assert.equal(timeline[0]?.record, records[0]);
  assert.deepEqual(records.map((record) => record.ts), [1000, 1200, 1200, 20_000, 20_400]);
});

test('timeline handles empty input, untimed metadata and zero idle cap', () => {
  assert.deepEqual(compressTimeline([]), []);
  assert.deepEqual(compressTimeline([{ type: 'header' }, { ts: 1000 }, { type: 'state' }, { ts: 1200 }]).map((entry) => entry.atMs), [0, 0, 0, 200]);
  assert.deepEqual(compressTimeline([{ ts: 100 }, { ts: 500 }], 1, 0).map((entry) => entry.atMs), [0, 0]);
});

test('timeline refuses invalid settings and timestamps', () => {
  for (const speed of [0, -1, Number.NaN, Infinity]) assert.throws(() => compressTimeline([], speed));
  for (const idleCap of [-1, Number.NaN, Infinity]) assert.throws(() => compressTimeline([], 1, idleCap));
  assert.throws(() => compressTimeline([{ ts: 100 }, { ts: 99 }]));
  assert.throws(() => compressTimeline([{ ts: Number.NaN }]));
});

test('redaction replaces every literal match with a padded replacement without shifting ANSI columns', () => {
  const ansiEscape = String.fromCharCode(27);
  const original = `${ansiEscape}[32msecret$secret${ansiEscape}[0m secret$secret`;
  const redacted = redactSameLength(original, [{ from: 'secret$secret', to: ' public ' }]);
  assert.equal(redacted, `${ansiEscape}[32mpublic       ${ansiEscape}[0m public       `);
  assert.equal(redacted.length, original.length);
  assert.equal(redactSameLength('abcabc', [{ from: 'abc', to: '' }]), '      ');
  assert.equal(redactSameLength('abc', [{ from: 'abc', to: ' abc ' }]), 'abc');
  assert.equal(redactSameLength('none', [{ from: 'abc', to: 'x' }]), 'none');
});

test('redaction refuses empty searches and replacements longer than the source even without a match', () => {
  assert.throws(() => redactSameLength('text', [{ from: '', to: '' }]));
  assert.throws(() => redactSameLength('text', [{ from: 'abc', to: ' abcd ' }]));
});

test('recording redaction replaces a target split across data chunks while keeping every chunk length', () => {
  const records = [{ type: 'data', ts: 0, data: 'Project: private-' }, { type: 'data', ts: 10, data: 'project ready' }];
  const redacted = redactRecording(records, [{ from: 'private-project', to: 'capture-demo' }]);
  assert.deepEqual(redacted.map((record) => record.data), ['Project: capture-', 'demo    ready']);
  assert.deepEqual(redacted.map((record) => record.ts), [0, 10]);
});

test('recording redaction fails closed when an escape sequence interrupts a target', () => {
  const ansiEscape = String.fromCharCode(27);
  const records = [{ type: 'data', ts: 0, data: `private-${ansiEscape}[1mproject` }];
  assert.throws(() => redactRecording(records, [{ from: 'private-project', to: 'capture-demo' }]), /refusing to capture/);
});

test('recording redaction rewrites hook payload strings and fails closed on a target hidden by JSON escaping', () => {
  const redactions = [{ from: 'private-project', to: 'capture-demo' }];
  const [hook] = redactRecording([{ type: 'hook', ts: 0, event: 'Stop', payload: { cwd: '/work/private-project', nested: ['private-project'] } }], redactions);
  assert.deepEqual(hook?.payload, { cwd: '/work/capture-demo   ', nested: ['capture-demo   '] });
  assert.throws(() => redactRecording([{ type: 'hook', ts: 0, event: 'Stop', payload: { message: 'a' } }], [{ from: '"a"', to: '' }]), /refusing to capture/);
});

test('recording redaction leaves clean input unchanged', () => {
  const ansiEscape = String.fromCharCode(27);
  const records = [{ type: 'resize', ts: 0, cols: 80, rows: 24 }, { type: 'data', ts: 1, data: `${ansiEscape}[32mclean${ansiEscape}[0m` }, { type: 'hook', ts: 2, event: 'Stop', payload: { cwd: '/work' } }];
  assert.deepEqual(redactRecording(records, [{ from: 'private-project', to: 'capture-demo' }]), records);
});

test('capture recording keeps file order and reads the header agent from its own validated parse', () => {
  const records = parseCaptureRecording('{"type":"header","agent":"claude-code"}\n{"type":"data","ts":5,"data":"b"}\n{"type":"hook","ts":9,"event":"Stop"}');
  assert.deepEqual(records, [{ type: 'data', ts: 5, data: 'b' }, { type: 'hook', ts: 9, event: 'Stop' }]);
  assert.throws(() => parseCaptureRecording('{"type":"header","agent":"claude-code"}\nnot json\n{"type":"data","ts":0,"data":"a"}'));
});

test('manifest refuses duplicate names, invalid shot targets, path traversal and invalid numeric settings', () => {
  const manifest = validateManifest(sampleManifest);
  assert.throws(() => validateManifest({ ...manifest, sessions: [manifest.sessions[0], manifest.sessions[0]] }));
  assert.throws(() => validateManifest({ ...manifest, shots: [{ atMs: 0, name: 'shot', selectSession: 'missing' }] }));
  assert.throws(() => validateManifest({ ...manifest, shots: [{ atMs: manifest.videoMs + 1, name: 'shot' }] }));
  assert.throws(() => validateManifest({ ...manifest, shots: [{ atMs: 0, name: '../escape' }] }));
  assert.throws(() => validateManifest({ ...manifest, shots: [{ atMs: 0, name: 'shot' }, { atMs: 1, name: 'shot' }] }));
  for (const speed of [0, -1, Infinity]) assert.throws(() => validateManifest({ ...manifest, speed }));
  assert.throws(() => validateManifest({ ...manifest, maxIdleGapMs: -1 }));
  assert.throws(() => validateManifest({ ...manifest, viewport: { width: 0, height: 800 } }));
  assert.throws(() => validateManifest({ ...manifest, unexpected: true }));
});

test('capture recording rejects malformed JSONL, incomplete records, other agents and signal-only recordings', () => {
  for (const text of ['{', '{"type":"data","ts":0}', '{"type":"resize","ts":0,"cols":80}', '{"type":"hook","ts":0}']) assert.throws(() => parseCaptureRecording(text));
  assert.throws(() => parseCaptureRecording('{"type":"header","agent":"codex"}\n{"type":"data","ts":0,"data":"text"}'));
  assert.throws(() => parseCaptureRecording('{"type":"hook","ts":0,"event":"Stop"}'));
});

test('hook endpoint discovery preserves bearer query and supports both settings argument forms', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'ignored' }, { type: 'http', url: 'http://127.0.0.1:34567/hook/session-id/Stop?t=token' }] }] } };
  const endpoint = { base: 'http://127.0.0.1:34567/hook/session-id', query: '?t=token', sessionId: 'session-id' };
  assert.deepEqual(findHookEndpoint(['--settings', 'settings.json'], settings), endpoint);
  assert.deepEqual(findHookEndpoint(['--settings=settings.json'], settings), endpoint);
  assert.throws(() => findHookEndpoint([], settings));
  assert.throws(() => findHookEndpoint(['--settings', 'file'], { hooks: {} }));
  assert.throws(() => findHookEndpoint(['--settings', 'file'], { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://example.com/hook/session/Stop' }] }] } }));
});

test('capture manifest defaults to unseeded projects and accepts slug-named seed directories', () => {
  assert.deepEqual(validateManifest(sampleManifest).projects, {});
  const manifest = validateManifest({ ...validateManifest(sampleManifest), projects: { web: 'demo/web' } });
  assert.deepEqual(manifest.projects, { web: 'demo/web' });
  assert.throws(() => validateManifest({ ...manifest, projects: { 'Web App': 'demo/web' } }));
});

test('demo record and capture manifests stay valid and seed every project from an existing directory', () => {
  const recordManifest = validateRecordManifest(demoRecordManifest);
  const captureManifest = validateManifest(demoCaptureManifest);
  for (const seedDirectory of [...Object.values(recordManifest.projects), ...Object.values(captureManifest.projects)]) {
    assert.ok(fs.statSync(path.join(fixtureDirectory, seedDirectory)).isDirectory(), seedDirectory);
  }
  assert.deepEqual(captureManifest.projects, recordManifest.projects);
  assert.deepEqual(captureManifest.viewport, recordManifest.viewport);
});

test('record manifest defaults model, permissions, time budget and output directory', () => {
  const manifest = validateRecordManifest({ viewport: { width: 1440, height: 900 }, projects: { web: 'demo/web' }, sessions: [{ name: 'fix-upload', project: 'web', task: 'Fix the test.' }] });
  assert.equal(manifest.model, 'sonnet');
  assert.equal(manifest.outputDirectory, '../recordings');
  assert.equal(manifest.sessions[0]?.dangerouslySkipPermissions, false);
  assert.equal(manifest.sessions[0]?.maxMinutes, 5);
});

test('record manifest refuses unseeded projects, duplicate or unsafe names, multi-line tasks and runaway budgets', () => {
  const manifest = validateRecordManifest(demoRecordManifest);
  const [firstSession] = manifest.sessions;
  assert.ok(firstSession);
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [{ ...firstSession, project: 'missing' }] }), /project has no seed directory/);
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [firstSession, firstSession] }), /duplicate session name/);
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [{ ...firstSession, name: '../escape' }] }));
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [{ ...firstSession, task: 'first line\nsecond line' }] }), /one line/);
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [{ ...firstSession, task: '   ' }] }));
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [{ ...firstSession, maxMinutes: 31 }] }));
  assert.throws(() => validateRecordManifest({ ...manifest, model: 'sonnet; rm -rf' }));
  assert.throws(() => validateRecordManifest({ ...manifest, sessions: [] }));
});

test('startup screen spots the folder trust prompt and its selected answer before the input prompt that shares its glyph', () => {
  const promptGlyph = String.fromCharCode(0x276f);
  assert.equal(classifyClaudeStartup([' Accessing workspace:', ` ${promptGlyph} No, exit`, '   Yes, I trust this folder']), 'trust-prompt');
  assert.equal(classifyClaudeStartup(['   Yes, I trust', ' this folder']), 'trust-prompt');
  assert.equal(classifyClaudeStartup(['   No, exit', ` ${promptGlyph} Yes, I trust this folder`]), 'trust-accept-selected');
  assert.equal(classifyClaudeStartup([' Claude Code', `${promptGlyph} Try "edit <filepath> to..."`]), 'ready');
  assert.equal(classifyClaudeStartup([promptGlyph]), 'ready');
  assert.equal(classifyClaudeStartup([`${promptGlyph}${String.fromCharCode(0xa0)}Try "how do I log an error?"`]), 'ready');
  assert.equal(classifyClaudeStartup(['', ' Claude Code']), 'starting');
  assert.equal(classifyClaudeStartup([]), 'starting');
});

test('a run settles only once it has worked and its latest state is a resting one', () => {
  assert.equal(hasRunSettled([]), false);
  assert.equal(hasRunSettled(['IDLE']), false);
  assert.equal(hasRunSettled(['IDLE', 'RUNNING']), false);
  assert.equal(hasRunSettled(['IDLE', 'RUNNING', 'WAITING']), true);
  assert.equal(hasRunSettled(['RUNNING', 'COMPLETE']), true);
  assert.equal(hasRunSettled(['RUNNING', 'WAITING', 'RUNNING']), false);
});

test('capture recording drops recorder state, decision, input and footer records that replay never plays', () => {
  const recorderOnlyLines = ['{"type":"state","ts":1,"event":"user_start"}', '{"type":"decision","ts":1,"event":null}', '{"type":"input","ts":1,"data":"typed"}', '{"type":"footer","ts":4}'];
  const records = parseCaptureRecording([...recorderOnlyLines, '{"type":"data","ts":2,"data":"a"}', '{"type":"hook","ts":3,"event":"stop"}'].join('\n'));
  assert.deepEqual(records.map((record) => record.type), ['data', 'hook']);
  assert.throws(() => parseCaptureRecording('{"type":"data","ts":2,"data":"a"}\n{"type":"hook","ts":3,"event":"../stop"}'));
});

test('isRecordingClosed reads only the last newline-terminated recording line', () => {
  const header = `${JSON.stringify({ type: 'header', agent: 'claude-code' })}\n`;
  const footer = `${JSON.stringify({ type: 'footer', ts: 2 })}\n`;
  assert.equal(isRecordingClosed(`${header}${footer}`), true);
  assert.equal(isRecordingClosed(`${header}${JSON.stringify({ type: 'data', ts: 1, data: 'x' })}\n`), false);
  assert.equal(isRecordingClosed(`${header}{"type":"foo`), false);
  assert.equal(isRecordingClosed(`${header}{"type":"foo\n`), false);
  assert.equal(isRecordingClosed(''), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { pickAutoResume, resolveResumeTarget, shouldAdoptReportedResumeId, RESUME_ID_RE } from '../session/core/auto-resume.ts';
import { projectDirCandidates } from '../server/core/usage-scan-core.ts';

const RESUME_SESSION_ID = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';
const REPORTED_SESSION_ID = '11111111-1111-4111-8111-111111111111';

function resolvedIdAndPath(resumeTarget: ReturnType<typeof resolveResumeTarget>) {
  return { resumeSessionId: resumeTarget.resumeSessionId, transcriptPath: resumeTarget.transcriptPath };
}

test('resolveResumeTarget returns null without probing when no resume id is set', () => {
  let probeCount = 0;
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: null,
    transcriptPath: '/reported/session.jsonl',
    projectsDirs: ['/home/carbon-unit/.claude/projects'],
    cwds: ['/workspace'],
  }, () => {
    probeCount += 1;
    return true;
  });

  assert.deepEqual(resolvedIdAndPath(resumeTarget), { resumeSessionId: null, transcriptPath: null });
  assert.equal(probeCount, 0);
});

test('resolveResumeTarget probes a reported transcript path before any derived one', () => {
  const reportedTranscriptPath = path.join('/reported', `${RESUME_SESSION_ID}.jsonl`);
  const probedPaths: string[] = [];
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: reportedTranscriptPath,
    projectsDirs: ['/configured/projects'],
    cwds: ['/workspace'],
  }, (transcriptPath) => {
    probedPaths.push(transcriptPath);
    return true;
  });

  assert.deepEqual(probedPaths, [reportedTranscriptPath]);
  assert.deepEqual(resolvedIdAndPath(resumeTarget), {
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: reportedTranscriptPath,
  });
});

test('resolveResumeTarget ignores a reported transcript path belonging to another conversation', () => {
  const otherConversationTranscriptPath = path.join(
    '/configured', 'projects', '-workspace', '11111111-1111-4111-8111-111111111111.jsonl');
  const derivedTranscriptPath = path.join(
    '/configured', 'projects', '-workspace', `${RESUME_SESSION_ID}.jsonl`);
  const probedPaths: string[] = [];
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: otherConversationTranscriptPath,
    projectsDirs: ['/configured/projects'],
    cwds: ['/workspace'],
  }, (transcriptPath) => {
    probedPaths.push(transcriptPath);
    return true;
  });

  assert.deepEqual(probedPaths, [derivedTranscriptPath]);
  assert.deepEqual(resolvedIdAndPath(resumeTarget), {
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: derivedTranscriptPath,
  });
});

test('resolveResumeTarget clears the id when only another conversation transcript exists', () => {
  const otherConversationTranscriptPath = path.join(
    '/configured', 'projects', '-workspace', '11111111-1111-4111-8111-111111111111.jsonl');
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: otherConversationTranscriptPath,
    projectsDirs: ['/configured/projects'],
    cwds: ['/workspace'],
  }, (transcriptPath) => transcriptPath === otherConversationTranscriptPath);

  assert.deepEqual(resolvedIdAndPath(resumeTarget), {
    resumeSessionId: null,
    transcriptPath: path.join('/configured', 'projects', '-workspace', `${RESUME_SESSION_ID}.jsonl`),
  });
});

test('resolveResumeTarget keeps the id when the CLAUDE_CONFIG_DIR transcript exists', () => {
  const projectsDirs = projectDirCandidates({ CLAUDE_CONFIG_DIR: '/configured', HOME: '/home/carbon-unit' });
  const expectedTranscriptPath = path.join('/configured', 'projects', '-workspace', `${RESUME_SESSION_ID}.jsonl`);
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: null,
    projectsDirs,
    cwds: ['/workspace'],
  }, (transcriptPath) => transcriptPath === expectedTranscriptPath);

  assert.deepEqual(resolvedIdAndPath(resumeTarget), { resumeSessionId: RESUME_SESSION_ID, transcriptPath: expectedTranscriptPath });
});

test('resolveResumeTarget keeps the id when only the XDG projects dir holds the transcript', () => {
  const projectsDirs = projectDirCandidates({ HOME: '/home/carbon-unit', XDG_CONFIG_HOME: '/xdg-config' });
  const expectedTranscriptPath = path.join('/xdg-config', 'claude', 'projects', '-workspace', `${RESUME_SESSION_ID}.jsonl`);
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: null,
    projectsDirs,
    cwds: ['/workspace'],
  }, (transcriptPath) => transcriptPath === expectedTranscriptPath);

  assert.deepEqual(resolvedIdAndPath(resumeTarget), { resumeSessionId: RESUME_SESSION_ID, transcriptPath: expectedTranscriptPath });
});

test('resolveResumeTarget keeps the id when the transcript sits under the realpath cwd spelling', () => {
  const expectedTranscriptPath = path.join('/configured', 'projects', '-real-workspace', `${RESUME_SESSION_ID}.jsonl`);
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: null,
    projectsDirs: ['/configured/projects'],
    cwds: ['/symlinked/workspace', '/real/workspace'],
  }, (transcriptPath) => transcriptPath === expectedTranscriptPath);

  assert.deepEqual(resolvedIdAndPath(resumeTarget), { resumeSessionId: RESUME_SESSION_ID, transcriptPath: expectedTranscriptPath });
});

test('resolveResumeTarget clears the id when no candidate transcript exists', () => {
  const probedPaths: string[] = [];
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: null,
    projectsDirs: ['/xdg-config/claude/projects', '/home/carbon-unit/.claude/projects'],
    cwds: ['/symlinked/workspace', '/real/workspace'],
  }, (transcriptPath) => {
    probedPaths.push(transcriptPath);
    return false;
  });

  assert.equal(probedPaths.length, 4);
  assert.deepEqual(resolvedIdAndPath(resumeTarget), {
    resumeSessionId: null,
    transcriptPath: path.join('/xdg-config', 'claude', 'projects', '-symlinked-workspace', `${RESUME_SESSION_ID}.jsonl`),
  });
});

test('resolveResumeTarget reports every candidate it checked when no transcript exists', () => {
  const resumeTarget = resolveResumeTarget({
    resumeSessionId: RESUME_SESSION_ID,
    transcriptPath: null,
    projectsDirs: ['/xdg-config/claude/projects', '/home/carbon-unit/.claude/projects'],
    cwds: ['/symlinked/workspace', '/real/workspace'],
  }, () => false);

  assert.deepEqual(resumeTarget.checkedTranscriptPaths, [
    path.join('/xdg-config', 'claude', 'projects', '-symlinked-workspace', `${RESUME_SESSION_ID}.jsonl`),
    path.join('/xdg-config', 'claude', 'projects', '-real-workspace', `${RESUME_SESSION_ID}.jsonl`),
    path.join('/home/carbon-unit', '.claude', 'projects', '-symlinked-workspace', `${RESUME_SESSION_ID}.jsonl`),
    path.join('/home/carbon-unit', '.claude', 'projects', '-real-workspace', `${RESUME_SESSION_ID}.jsonl`),
  ]);
});

test('shouldAdoptReportedResumeId adopts any id when nothing is bound yet', () => {
  assert.equal(shouldAdoptReportedResumeId({
    currentResumeSessionId: null,
    reportedId: REPORTED_SESSION_ID,
    signal: 'session-start',
    sessionStartSource: 'startup',
  }), true);
});

test('shouldAdoptReportedResumeId reports no change when the id is already the bound one', () => {
  assert.equal(shouldAdoptReportedResumeId({
    currentResumeSessionId: RESUME_SESSION_ID,
    reportedId: RESUME_SESSION_ID,
    signal: 'ready',
    sessionStartSource: null,
  }), false);
});

test('shouldAdoptReportedResumeId keeps the bound id when a blank spawn announces a new one at SessionStart', () => {
  for (const sessionStartSource of ['startup', 'resume', 'compact', 'fork', null, undefined]) {
    assert.equal(shouldAdoptReportedResumeId({
      currentResumeSessionId: RESUME_SESSION_ID,
      reportedId: REPORTED_SESSION_ID,
      signal: 'session-start',
      sessionStartSource,
    }), false, `SessionStart source ${String(sessionStartSource)}`);
  }
});

test('shouldAdoptReportedResumeId adopts a SessionStart id after /clear, whatever the letter case', () => {
  for (const sessionStartSource of ['clear', 'Clear', 'CLEAR']) {
    assert.equal(shouldAdoptReportedResumeId({
      currentResumeSessionId: RESUME_SESSION_ID,
      reportedId: REPORTED_SESSION_ID,
      signal: 'session-start',
      sessionStartSource,
    }), true, sessionStartSource);
  }
});

test('shouldAdoptReportedResumeId keeps the bound id when SessionEnd names a different one', () => {
  assert.equal(shouldAdoptReportedResumeId({
    currentResumeSessionId: RESUME_SESSION_ID,
    reportedId: REPORTED_SESSION_ID,
    signal: 'session-end',
    sessionStartSource: null,
  }), false);
});

test('shouldAdoptReportedResumeId adopts a different id from any signal that proves a transcript exists', () => {
  for (const signal of ['resume', 'ready', 'awaiting-input', null, undefined]) {
    assert.equal(shouldAdoptReportedResumeId({
      currentResumeSessionId: RESUME_SESSION_ID,
      reportedId: REPORTED_SESSION_ID,
      signal,
      sessionStartSource: null,
    }), true, `signal ${String(signal)}`);
  }
});

test('shouldAdoptReportedResumeId keeps the bound id when a low confidence ready names a different one', () => {
  assert.equal(shouldAdoptReportedResumeId({
    currentResumeSessionId: RESUME_SESSION_ID,
    reportedId: REPORTED_SESSION_ID,
    signal: 'ready',
    sessionStartSource: null,
    confidence: 'low',
  }), false);
});

test('shouldAdoptReportedResumeId adopts a low confidence report when nothing is bound yet', () => {
  assert.equal(shouldAdoptReportedResumeId({
    currentResumeSessionId: null,
    reportedId: REPORTED_SESSION_ID,
    signal: 'ready',
    sessionStartSource: null,
    confidence: 'low',
  }), true);
});

test('shouldAdoptReportedResumeId adopts a ready naming a different id when confidence is not low', () => {
  for (const confidence of ['high', null, undefined]) {
    assert.equal(shouldAdoptReportedResumeId({
      currentResumeSessionId: RESUME_SESSION_ID,
      reportedId: REPORTED_SESSION_ID,
      signal: 'ready',
      sessionStartSource: null,
      confidence,
    }), true, `confidence ${String(confidence)}`);
  }
});

test('pickAutoResume picks a project that was active and has a resumeSessionId', () => {
  const projects = [{ id: 'a', wasActive: true, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), ['a']);
});

test('pickAutoResume skips a dormant project even with a resumeSessionId', () => {
  const projects = [{ id: 'a', wasActive: false, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), []);
});

test('pickAutoResume skips an active project with no resumeSessionId (no silent --continue)', () => {
  const projects = [{ id: 'a', wasActive: true }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), []);
});

test('pickAutoResume returns nothing when autoResume is false (kill switch)', () => {
  const projects = [{ id: 'a', wasActive: true, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, { autoResume: false }), []);
});

test('pickAutoResume treats a missing config / autoResume field as enabled', () => {
  const projects = [{ id: 'a', wasActive: true, resumeSessionId: 'abcd1234' }];
  assert.deepEqual(pickAutoResume(projects, {}), ['a']);
  assert.deepEqual(pickAutoResume(projects, undefined), ['a']);
});

test('pickAutoResume picks only the matching subset across several projects', () => {
  const projects = [
    { id: 'picked', wasActive: true, resumeSessionId: 'abcd1234' },
    { id: 'dormant', wasActive: false, resumeSessionId: 'abcd1234' },
    { id: 'no-id', wasActive: true },
  ];
  assert.deepEqual(pickAutoResume(projects, { autoResume: true }), ['picked']);
});

test('pickAutoResume tolerates a non-array projects list', () => {
  assert.deepEqual(pickAutoResume(null, { autoResume: true }), []);
  assert.deepEqual(pickAutoResume(undefined, { autoResume: true }), []);
});

test('RESUME_ID_RE is THE session-id shape, imported by control-handlers rather than restated', () => {
  assert.ok(RESUME_ID_RE.test('4a3d4462-4cf7-4a23-8f00-ccec89a48ba5'), 'a Claude Code id');
  assert.ok(RESUME_ID_RE.test('01a030d4-6956-73c2-a74a-eedd17b6361d'), 'a codex id (UUIDv7, leading digit)');
  assert.ok(!RESUME_ID_RE.test('short'));
  assert.ok(!RESUME_ID_RE.test('has spaces in it 1234'));

  const controlHandlersSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'server', 'control-handlers.ts'), 'utf8');
  assert.equal(/const RESUME_ID_RE\s*=\s*\//.test(controlHandlersSource), false,
    'control-handlers.ts must import RESUME_ID_RE, not restate it');
});

test('a captured id can never be a FLAG: the leading character must be alphanumeric', () => {
  assert.equal(RESUME_ID_RE.test('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(RESUME_ID_RE.test('--dangerously-skip-permissions'), false);
  assert.equal(RESUME_ID_RE.test('-p'), false);
  assert.equal(RESUME_ID_RE.test('-'.repeat(20)), false);
  assert.equal(RESUME_ID_RE.test('_leading-underscore-id'), false);
  assert.equal(RESUME_ID_RE.test(`a${'-'.repeat(127)}`), true, 'a dash is still legal after the first character');
});

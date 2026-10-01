import { z } from 'zod';
import type { ReplayRecord } from '../../detection/replay.ts';
import { HookPayload } from '../../shared/contracts/hooks.ts';
import { MERGEABLE_LIVE_STATES, RESTARTABLE_STATES, STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';

export const Redaction = z.strictObject({
  from: z.string().min(1),
  to: z.string(),
}).refine(({ from, to }) => to.trim().length <= from.length, {
  message: 'redaction replacement after trimming must fit the original length',
});

const sessionName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/);
const projectSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const viewport = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });
const projectSeeds = z.record(projectSlug, z.string().min(1));

const CaptureSession = z.strictObject({
  name: sessionName,
  project: z.string().trim().min(1),
  recording: z.string().min(1),
  patch: z.string().min(1).optional(),
  patchAtEvent: z.string().regex(/^[A-Za-z]+$/).default('Stop'),
});

export const CaptureManifest = z.strictObject({
  viewport,
  projects: projectSeeds.default({}),
  speed: z.number().finite().positive().default(1),
  maxIdleGapMs: z.number().finite().nonnegative().default(2500),
  redactions: z.array(Redaction).default([]),
  sessions: z.array(CaptureSession).min(1),
  shots: z.array(z.strictObject({
    atMs: z.number().finite().nonnegative(),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    selectSession: z.string().optional(),
  })).default([]),
  videoMs: z.number().finite().positive(),
}).superRefine((manifest, context) => {
  const sessionNames = new Set<string>();
  for (const [index, session] of manifest.sessions.entries()) {
    if (sessionNames.has(session.name)) context.addIssue({ code: 'custom', path: ['sessions', index, 'name'], message: 'duplicate session name' });
    sessionNames.add(session.name);
  }
  const shotNames = new Set<string>();
  for (const [index, shot] of manifest.shots.entries()) {
    if (shotNames.has(shot.name)) context.addIssue({ code: 'custom', path: ['shots', index, 'name'], message: 'duplicate shot name' });
    shotNames.add(shot.name);
    if (shot.atMs > manifest.videoMs) context.addIssue({ code: 'custom', path: ['shots', index, 'atMs'], message: 'shot must fall within videoMs' });
    if (shot.selectSession !== undefined && !sessionNames.has(shot.selectSession)) {
      context.addIssue({ code: 'custom', path: ['shots', index, 'selectSession'], message: 'unknown session name' });
    }
  }
});

export type CaptureManifest = z.infer<typeof CaptureManifest>;

const RecordSession = z.strictObject({
  name: projectSlug,
  project: projectSlug,
  task: z.string().trim().min(1).max(1500).regex(/^[^\r\n]+$/, 'task must be one line so Enter submits it'),
  dangerouslySkipPermissions: z.boolean().default(false),
  maxMinutes: z.number().finite().positive().max(30).default(5),
});

export const RecordManifest = z.strictObject({
  viewport,
  model: z.string().regex(/^[A-Za-z0-9._-]+$/).default('sonnet'),
  projects: projectSeeds,
  sessions: z.array(RecordSession).min(1),
  outputDirectory: z.string().min(1).default('../recordings'),
}).superRefine((manifest, context) => {
  const sessionNames = new Set<string>();
  for (const [index, session] of manifest.sessions.entries()) {
    if (sessionNames.has(session.name)) context.addIssue({ code: 'custom', path: ['sessions', index, 'name'], message: 'duplicate session name' });
    sessionNames.add(session.name);
    if (!(session.project in manifest.projects)) context.addIssue({ code: 'custom', path: ['sessions', index, 'project'], message: 'project has no seed directory' });
  }
});

export type RecordManifest = z.infer<typeof RecordManifest>;

export function validateRecordManifest(document: unknown): RecordManifest {
  return RecordManifest.parse(document);
}

export type ClaudeStartupScreen = 'trust-prompt' | 'trust-accept-selected' | 'ready' | 'starting';

const promptGlyph = String.fromCharCode(0x276f);
const inputPromptLine = new RegExp(`^\\s*${promptGlyph}(\\s|$)`);

export function classifyClaudeStartup(screenLines: readonly string[]): ClaudeStartupScreen {
  const compactScreen = screenLines.join('').replace(/\s+/g, '');
  if (compactScreen.includes(`${promptGlyph}Yes,Itrustthisfolder`)) return 'trust-accept-selected';
  if (compactScreen.includes('Itrustthisfolder')) return 'trust-prompt';
  if (screenLines.some((line) => inputPromptLine.test(line))) return 'ready';
  return 'starting';
}

const settledStates = new Set<SessionState>([...MERGEABLE_LIVE_STATES, ...RESTARTABLE_STATES]);

export function hasRunSettled(statesSeen: readonly SessionState[]): boolean {
  const firstRunningIndex = statesSeen.indexOf(STATES.RUNNING);
  if (firstRunningIndex < 0) return false;
  const latestState = statesSeen.at(-1);
  return latestState !== undefined && settledStates.has(latestState);
}
export type Redaction = z.infer<typeof Redaction>;

export const ReplayEnvironment = z.strictObject({
  manifest: CaptureManifest,
  sessionsById: z.record(z.string(), CaptureSession),
  tempDirectory: z.string().min(1),
});
export type ReplayEnvironment = z.infer<typeof ReplayEnvironment>;

export const ReplayStatus = z.strictObject({
  phase: z.enum(['ready', 'complete', 'failed']),
  pid: z.number().int().positive(),
  warning: z.string().optional(),
  error: z.string().optional(),
  patchApplied: z.boolean().optional(),
});

export function validateManifest(document: unknown): CaptureManifest {
  return CaptureManifest.parse(document);
}

export function compressTimeline<RecordWithTimestamp extends { ts?: number }>(
  records: readonly RecordWithTimestamp[], speed = 1, maxIdleGapMs = 2500,
): { record: RecordWithTimestamp; atMs: number }[] {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('speed must be positive and finite');
  if (!Number.isFinite(maxIdleGapMs) || maxIdleGapMs < 0) throw new Error('maxIdleGapMs must be nonnegative and finite');
  let previousTimestamp = records.find((record) => record.ts !== undefined)?.ts ?? 0;
  let elapsedMs = 0;
  return records.map((record) => {
    const timestamp = record.ts ?? previousTimestamp;
    if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) throw new Error('record timestamps must be finite and chronological');
    elapsedMs += Math.min((timestamp - previousTimestamp) / speed, maxIdleGapMs);
    previousTimestamp = timestamp;
    return { record, atMs: elapsedMs };
  });
}

export function redactSameLength(text: string, redactions: readonly Redaction[]): string {
  let redactedText = text;
  for (const replacement of redactions) {
    const { from, to } = Redaction.parse(replacement);
    const paddedReplacement = to.trim().slice(0, from.length).padEnd(from.length, ' ');
    redactedText = redactedText.split(from).join(paddedReplacement);
  }
  return redactedText;
}

export const RecordType = z.object({ type: z.string() }).passthrough();

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isRecordingClosed(recordingText: string): boolean {
  const lastNewlineIndex = recordingText.lastIndexOf('\n');
  if (lastNewlineIndex < 0) return false;
  const terminatedText = recordingText.slice(0, lastNewlineIndex);
  const lastTerminatedLine = terminatedText.slice(terminatedText.lastIndexOf('\n') + 1);
  const parsedRecord = RecordType.safeParse(parseJsonOrNull(lastTerminatedLine));
  return parsedRecord.success && parsedRecord.data.type === 'footer';
}
const replayedOrHeaderTypes = new Set(['header', 'data', 'hook', 'resize']);

const CaptureRecord = z.object({
  type: z.string(),
  ts: z.number().finite().nonnegative().optional(),
  data: z.string().optional(),
  event: z.string().regex(/^[A-Za-z]+$/).optional(),
  payload: HookPayload.optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
}).passthrough().superRefine((record, context) => {
  if (['data', 'hook', 'resize'].includes(record.type) && record.ts === undefined) {
    context.addIssue({ code: 'custom', message: 'replay records need a timestamp' });
  }
  if (record.type === 'data' && record.data === undefined) context.addIssue({ code: 'custom', message: 'data record needs data' });
  if (record.type === 'hook' && record.event === undefined) context.addIssue({ code: 'custom', message: 'hook record needs event' });
  if (record.type === 'resize' && (record.cols === undefined || record.rows === undefined)) {
    context.addIssue({ code: 'custom', message: 'resize record needs cols and rows' });
  }
});

export function parseCaptureRecording(text: string): ReplayRecord[] {
  let agent: string | null = null;
  const records: ReplayRecord[] = [];
  for (const line of text.split(/\r?\n/).filter((line) => line.trim().length > 0)) {
    const document: unknown = JSON.parse(line);
    if (!replayedOrHeaderTypes.has(RecordType.parse(document).type)) continue;
    const record = CaptureRecord.parse(document);
    if (record.type !== 'header') { records.push(record); continue; }
    agent = typeof record.agent === 'string' ? record.agent : null;
  }
  if (agent !== null && agent !== 'claude-code') throw new Error('site capture requires a Claude Code recording');
  if (!records.some((record) => record.type === 'data')) throw new Error('recording has no terminal data');
  return records;
}

const terminalEscapeSequence = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

function redactValue(value: unknown, redactions: readonly Redaction[]): unknown {
  if (typeof value === 'string') return redactSameLength(value, redactions);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactions));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSameLength(key, redactions), redactValue(item, redactions)]));
}

function assertNoSurvivingRedaction(text: string, redactions: readonly Redaction[], location: string): void {
  const leakedRedaction = redactions.find(({ from }) => text.includes(from));
  if (leakedRedaction) throw new Error(`redaction target survives in ${location}; refusing to capture`);
}

export function redactRecording(records: readonly ReplayRecord[], redactions: readonly Redaction[]): ReplayRecord[] {
  const terminalChunks = records.flatMap((record) => record.type === 'data' && typeof record.data === 'string' ? [record.data] : []);
  const redactedStream = redactSameLength(terminalChunks.join(''), redactions);
  assertNoSurvivingRedaction(redactedStream.replace(terminalEscapeSequence, ''), redactions, 'terminal output');
  let streamOffset = 0;
  return records.map((record) => {
    if (record.type === 'data' && typeof record.data === 'string') {
      const redactedChunk = redactedStream.slice(streamOffset, streamOffset + record.data.length);
      streamOffset += record.data.length;
      return { ...record, data: redactedChunk };
    }
    if (record.payload === undefined) return record;
    const payload = HookPayload.parse(redactValue(record.payload, redactions));
    assertNoSurvivingRedaction(JSON.stringify(payload), redactions, `${record.event ?? 'hook'} payload`);
    return { ...record, payload };
  });
}

const HookSettings = z.object({
  hooks: z.record(z.string(), z.array(z.object({
    hooks: z.array(z.object({ type: z.string(), url: z.string().optional() }).passthrough()),
  }).passthrough())),
}).passthrough();

export function findHookEndpoint(argv: readonly string[], settingsDocument: unknown): { base: string; query: string; sessionId: string } {
  if (!argv.some((argument) => argument === '--settings' || argument.startsWith('--settings='))) throw new Error('missing --settings');
  const settings = HookSettings.parse(settingsDocument);
  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        if (hook.type !== 'http' || !hook.url) continue;
        const url = new URL(hook.url);
        if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('hook endpoint must be local HTTP');
        const sessionId = /^\/hook\/([^/]+)/.exec(url.pathname)?.[1];
        if (!sessionId) throw new Error('invalid hook endpoint path');
        return { base: `${url.origin}/hook/${sessionId}`, query: url.search, sessionId: decodeURIComponent(sessionId) };
      }
    }
  }
  throw new Error('no injected HTTP hook endpoint');
}

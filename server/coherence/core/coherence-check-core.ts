import { z } from 'zod';
import { COHERENCE_CHECK_DETAIL_MAX_CHARS, COHERENCE_CHECK_STAGE_IDS } from '../../../shared/contracts/coherence.ts';
import type {
  CoherenceCheckStage, CoherenceCheckStageId, CoherenceJournalEntry, CoherenceRegulationReading, ProjectCoherenceCheckResult, ProjectCoherenceTrend,
} from '../../../shared/contracts/coherence.ts';
import type { CoherenceHooksState } from '../../../shared/contracts/session.ts';
import { parseJsonOrNull } from '../../core/json-core.ts';
import { sanitizeOneLine } from '../../core/text-core.ts';
import { COHERENCE_PACKAGE_NAME } from './coherence-adopt-core.ts';
import { COHERENCE_CONFIG_FILENAME } from './coherence-config-core.ts';
import type { CoherenceHost } from './coherence-session-core.ts';

type CoherenceCheckOutcome = Pick<CoherenceCheckStage, 'status' | 'detail'>;

const STAGE_PREREQUISITES: Readonly<Record<CoherenceCheckStageId, readonly CoherenceCheckStageId[]>> = Object.freeze({
  setting: [],
  install: [],
  'hooks-claude': ['install'],
  'hooks-codex': ['install'],
  'session-start': ['install'],
  journal: ['session-start'],
  'next-action': ['journal'],
  readings: ['install'],
  'live-sessions': ['setting', 'install'],
});

const COHERENCE_CHECK_PROBE_PREFIX = 'glimmervoid-check-';
const COHERENCE_SESSION_START_MARKER = 'DECISION JOURNAL';
const COHERENCE_HOOK_LAUNCHER = '.claude/coherence-hook';
const COHERENCE_LOCKFILE_PACKAGE_KEY = `node_modules/${COHERENCE_PACKAGE_NAME}`;
const DECIDE_OUTPUT_ID = /^(d-[0-9a-f]{8})\s/m;
const SHORT_SHA_LENGTH = 7;
const READING_INSTRUMENTS = ['drift', 'decompose', 'redundancy', 'mass'] as const;
const READING_TIP_GRACE_MS = 10 * 60_000;
const COMPARABLE_ROWS_FOR_DIRECTION = 2;

const SessionStartSettings = z.looseObject({
  hooks: z.looseObject({
    SessionStart: z.array(z.looseObject({ hooks: z.array(z.looseObject({ type: z.string(), command: z.unknown() })) })),
  }),
});

const SessionStartOutput = z.looseObject({
  hookSpecificOutput: z.looseObject({ hookEventName: z.literal('SessionStart'), additionalContext: z.string() }),
});

const LockfileShape = z.looseObject({ packages: z.record(z.string(), z.looseObject({ version: z.unknown() })) });
const PackageShape = z.looseObject({ dependencies: z.record(z.string(), z.unknown()).optional(), devDependencies: z.record(z.string(), z.unknown()).optional() });

function passed(detail: string): CoherenceCheckOutcome {
  return { status: 'pass', detail };
}

function failed(detail: string): CoherenceCheckOutcome {
  return { status: 'fail', detail };
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function coherenceCheckStage(id: CoherenceCheckStageId, outcome: CoherenceCheckOutcome): CoherenceCheckStage {
  const detail = sanitizeOneLine(outcome.detail, COHERENCE_CHECK_DETAIL_MAX_CHARS);
  return { id, status: outcome.status, detail: detail === '' ? outcome.status : detail };
}

function prerequisiteSkip(id: CoherenceCheckStageId, finishedStages: readonly CoherenceCheckStage[]): CoherenceCheckStage | null {
  const unmet = STAGE_PREREQUISITES[id].find((prerequisite) => finishedStages.find((stage) => stage.id === prerequisite)?.status !== 'pass');
  return unmet === undefined ? null : coherenceCheckStage(id, { status: 'skip', detail: `needs ${unmet}` });
}

function summarizeCoherenceCheck(projectId: string, stages: readonly CoherenceCheckStage[]): ProjectCoherenceCheckResult {
  return { projectId, ok: !stages.some((stage) => stage.status === 'fail'), stages: [...stages] };
}

function judgeCoherenceSetting({ isFactoryEnabled, isSettingOn }: { isFactoryEnabled: boolean; isSettingOn: boolean }): CoherenceCheckOutcome {
  if (isFactoryEnabled) return passed('Factory always uses Coherence');
  if (isSettingOn) return passed('Settings > Lanes > Coherence is on');
  return failed('Settings > Lanes > Coherence is off');
}

function describeCoherencePin({ packageText, lockfileText }: { packageText: string | null; lockfileText: string | null }): string {
  const lockedVersion = LockfileShape.safeParse(parseJsonOrNull(lockfileText)).data?.packages[COHERENCE_LOCKFILE_PACKAGE_KEY]?.version;
  if (typeof lockedVersion === 'string') return `${COHERENCE_PACKAGE_NAME} ${lockedVersion} pinned in package-lock.json`;
  const manifest = PackageShape.safeParse(parseJsonOrNull(packageText)).data;
  const declaredRange = manifest?.devDependencies?.[COHERENCE_PACKAGE_NAME] ?? manifest?.dependencies?.[COHERENCE_PACKAGE_NAME];
  if (typeof declaredRange === 'string') return `${COHERENCE_PACKAGE_NAME} ${declaredRange} declared in package.json with no lockfile pin`;
  return `${COHERENCE_PACKAGE_NAME} is not declared in package.json`;
}

function judgeCoherenceInstall({ tipSha, pinDescription }: { tipSha: string; pinDescription: string }): CoherenceCheckOutcome {
  return passed(`${COHERENCE_CONFIG_FILENAME} at ${shortSha(tipSha)} admitted; ${pinDescription}`);
}

function judgeCoherenceHooks({ host, state }: { host: CoherenceHost; state: CoherenceHooksState }): CoherenceCheckOutcome {
  if (!state.active) return failed(state.reason);
  if (host === 'codex') return passed('hooks --check --host codex passed; trust is per session worktree; see live sessions');
  return passed(`hooks --check --host ${host} passed`);
}

function coherenceSessionStartCommand(settingsText: string | null): string | null {
  const settings = SessionStartSettings.safeParse(parseJsonOrNull(settingsText));
  if (!settings.success) return null;
  const handlers = settings.data.hooks.SessionStart.flatMap((group) => group.hooks);
  const launcherHandler = handlers.find((handler) => handler.type === 'command' && typeof handler.command === 'string' && handler.command.includes(COHERENCE_HOOK_LAUNCHER));
  return typeof launcherHandler?.command === 'string' ? launcherHandler.command : null;
}

function coherenceProbeSessionId(randomHex: string): string {
  return `${COHERENCE_CHECK_PROBE_PREFIX}${randomHex}`;
}

function sessionStartPayload({ sessionId, cwd }: { sessionId: string; cwd: string }): string {
  return JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' });
}

function judgeSessionStartOutput(stdout: string, sessionId: string): CoherenceCheckOutcome {
  const output = SessionStartOutput.safeParse(parseJsonOrNull(stdout));
  if (!output.success) return failed('the SessionStart hook printed no SessionStart additionalContext');
  const context = output.data.hookSpecificOutput.additionalContext;
  if (!context.includes(COHERENCE_SESSION_START_MARKER)) return failed(`the SessionStart additionalContext lacks the ${COHERENCE_SESSION_START_MARKER} instructions`);
  if (!context.includes(`YOUR SESSION ID IS ${sessionId}`)) return failed(`the SessionStart additionalContext does not name the probe session ${sessionId}`);
  return passed(`additionalContext carries the ${COHERENCE_SESSION_START_MARKER} instructions for ${sessionId}`);
}

function decisionIdFromDecideOutput(stdout: string): string | null {
  return DECIDE_OUTPUT_ID.exec(stdout)?.[1] ?? null;
}

function judgeJournalReadBack({ probeId, probeText, entries }: { probeId: string; probeText: string; entries: readonly CoherenceJournalEntry[] }): CoherenceCheckOutcome {
  const latest = entries[entries.length - 1];
  if (!latest) return failed(`the feed read no journal entry back for the probe decision ${probeId}`);
  if (latest.id !== probeId) return failed(`the feed's latest entry is ${latest.id}, not the probe decision ${probeId}`);
  if (latest.text !== probeText) return failed(`the feed read ${probeId} back with different text`);
  return passed(`probe decision ${probeId} read back by the feed`);
}

function judgeNextAction(reading: CoherenceRegulationReading): CoherenceCheckOutcome {
  if (!reading.ok) return failed(reading.reason);
  const { action, rule } = reading.nextAction;
  return passed(rule === null ? action : `${action} (${rule})`);
}

function describeAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function judgeCoherenceReading({ trend, tipSha, nowMs }: { trend: ProjectCoherenceTrend | null; tipSha: string; nowMs: number }): CoherenceCheckOutcome {
  if (trend === null) return failed('no reading yet');
  const { latest } = trend;
  const ageMs = nowMs - Date.parse(latest.at);
  const readAt = `${shortSha(latest.sha)} read ${describeAge(ageMs)} ago`;
  const unavailableInstruments = READING_INSTRUMENTS.flatMap((instrument) => {
    const reading = latest[instrument];
    return reading.status === 'unavailable' ? [`${instrument} unavailable: ${reading.reason}`] : [];
  });
  if (unavailableInstruments.length > 0) return failed(`${readAt}: ${unavailableInstruments.join('; ')}`);
  const isAtTip = latest.sha === tipSha;
  if (!isAtTip && ageMs > READING_TIP_GRACE_MS) return failed(`${readAt}, but the integration tip ${shortSha(tipSha)} has not been read`);
  const pendingInstruments = READING_INSTRUMENTS.flatMap((instrument) => {
    const { status } = latest[instrument];
    return status === 'needs-components' || status === 'insufficient-history' ? [`${instrument} ${status}`] : [];
  });
  const direction = trend.trend.comparedRows >= COMPARABLE_ROWS_FOR_DIRECTION ? trend.trend.direction : 'no direction yet';
  const tipRelation = isAtTip ? 'at the integration tip' : `tip ${shortSha(tipSha)} not read yet`;
  return passed([readAt, direction, ...pendingInstruments, tipRelation].join(', '));
}

function judgeLiveSessions(sessions: readonly { name: string; coherenceHooks: CoherenceHooksState | null }[]): CoherenceCheckOutcome {
  if (sessions.length === 0) return { status: 'skip', detail: 'no live sessions' };
  const inactive = sessions.flatMap(({ name, coherenceHooks }) => (coherenceHooks?.active === false ? [`${name}: ${coherenceHooks.reason}`] : []));
  if (inactive.length > 0) return failed(inactive.join('; '));
  const activeCount = sessions.filter(({ coherenceHooks }) => coherenceHooks?.active === true).length;
  return passed(`${activeCount} of ${sessions.length} live sessions have active hooks, none inactive`);
}

function renderCoherenceCheckText(result: ProjectCoherenceCheckResult): string {
  if (result.error !== undefined) return `coherence check could not run for ${result.projectId || 'that project'}: ${result.error}`;
  const idWidth = Math.max(...COHERENCE_CHECK_STAGE_IDS.map((id) => id.length));
  const stageLines = result.stages.map((stage) => `${stage.status.toUpperCase().padEnd(4)}  ${stage.id.padEnd(idWidth)}  ${stage.detail}`);
  const failedCount = result.stages.filter((stage) => stage.status === 'fail').length;
  return [...stageLines, `${failedCount} failed`].join('\n');
}

type CoherenceCheckArgs = { ok: true; projectSelector: string | null; isJson: boolean } | { ok: false; error: string };

const COHERENCE_CHECK_USAGE = 'glimmervoid coherence check [--project <id or path>] [--json]';

function parseCoherenceCheckArgs(args: readonly string[]): CoherenceCheckArgs {
  if (args[0] !== 'check') return { ok: false, error: `expected ${COHERENCE_CHECK_USAGE}` };
  let projectSelector: string | null = null;
  let isJson = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json') {
      isJson = true;
      continue;
    }
    const value = args[index + 1];
    if (flag !== '--project' || value === undefined || value.startsWith('--')) return { ok: false, error: `expected ${COHERENCE_CHECK_USAGE}` };
    projectSelector = value;
    index += 1;
  }
  return { ok: true, projectSelector, isJson };
}

export type { CoherenceCheckOutcome };
export {
  coherenceCheckStage, coherenceProbeSessionId, coherenceSessionStartCommand, decisionIdFromDecideOutput, describeCoherencePin, judgeCoherenceHooks,
  judgeCoherenceInstall, judgeCoherenceReading, judgeCoherenceSetting, judgeJournalReadBack, judgeLiveSessions, judgeNextAction, judgeSessionStartOutput,
  parseCoherenceCheckArgs, prerequisiteSkip, renderCoherenceCheckText, sessionStartPayload, summarizeCoherenceCheck,
};

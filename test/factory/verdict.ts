import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { FactoryDecisionLogLine } from '../../shared/contracts/factory-decision-log.ts';
import { isPathInside } from '../../shared/paths.ts';
import type { FactoryQueueIntentResult, FactoryState } from '../../shared/contracts/factory.ts';
import type { ExpectedEnd } from './intents.ts';

export const failurePrecedence = ['interrupted', 'queue-refused', 'stalled', 'checks', 'review', 'exception', 'timeout'] as const;
export type FailureClass = typeof failurePrecedence[number];
export const matchedProductText = {
  verifyCloseSubject: { sourceFile: 'server/factory/factory-verifier.ts', text: 'factory: verify and close ' },
  promptStall: { sourceFile: 'server/factory/core/factory-core.ts', text: ' is waiting on a prompt' },
  startupStall: { sourceFile: 'server/factory/core/factory-core.ts', text: ' session did not start: check Claude Code folder trust' },
  idleStall: { sourceFile: 'server/factory/core/factory-core.ts', text: ' ended its turn with nothing running' },
} as const;
export interface RunningProcess {
  pid: number;
  command: string;
  resolvedArguments: string[];
  unresolvedRelativeArguments: string[];
}
export interface BuildOutput {
  directory: string;
  filePaths: readonly string[];
  folderPaths: readonly string[];
}
export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}
export interface Broadcast {
  arrivedAt: string;
  state: FactoryState;
}
export interface RealCommits {
  main: string | null;
  originMain: string | null;
}
export interface GateRemote {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
  resolvedFetchPaths: (string | null)[];
  resolvedPushPaths: (string | null)[];
}
export interface GateEvidence {
  snapshotRealMain: string;
  snapshotMain: string;
  originPath: string | null;
  before: RealCommits;
  after: RealCommits;
  remotes: GateRemote[] | null;
  leakedCommits: string[] | null;
  isCommitListCapped: boolean;
  proofErrors: string[];
}

export function hasOnlyLocalOrigin(remotes: GateRemote[], originPath: string): boolean {
  const origin = remotes[0];
  return remotes.length === 1 && origin?.name === 'origin'
    && origin.fetchUrls.length === 1 && origin.pushUrls.length === 1
    && origin.resolvedFetchPaths.length === 1 && origin.resolvedFetchPaths[0] === originPath
    && origin.resolvedPushPaths.length === 1 && origin.resolvedPushPaths[0] === originPath;
}

export function decideGate(evidence: GateEvidence | null): (GateEvidence & { held: boolean | null }) | null {
  if (!evidence) return null;
  const { originPath, remotes, leakedCommits } = evidence;
  const hasLeakedCommit = leakedCommits !== null && leakedCommits.length > 0;
  const hasForeignRemote = remotes !== null && originPath !== null && !hasOnlyLocalOrigin(remotes, originPath);
  if (hasLeakedCommit || hasForeignRemote) return { ...evidence, held: false };
  if (originPath === null || remotes === null || leakedCommits === null) return { ...evidence, held: null };
  return { ...evidence, held: true };
}

const LONGEST_BRIDGE_SOCKET_NAME = 'claude-socks-0123456789abcdef.sock';
const UNIX_SOCKET_PATH_BYTE_LIMIT = 107;

export function bridgeSocketPathRefusal(instanceTempDirectory: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'linux') return null;
  const socketPathBytes = Buffer.byteLength(path.join(instanceTempDirectory, LONGEST_BRIDGE_SOCKET_NAME));
  if (socketPathBytes <= UNIX_SOCKET_PATH_BYTE_LIMIT) return null;
  return `Factory harness refuses to start: the check sandbox socket under ${instanceTempDirectory} needs ${socketPathBytes} bytes and a unix socket path holds ${UNIX_SOCKET_PATH_BYTE_LIMIT}; point TMPDIR at a shorter folder`;
}

export interface VerdictInput {
  intentName: string;
  expectedEnd: ExpectedEnd;
  expectedRefusal: string | null;
  projectId: string;
  startedAt: string;
  endedAt: string;
  queueReply: FactoryQueueIntentResult | null;
  queueRepliedAt: string | null;
  broadcasts: Broadcast[];
  decisionLines: string[];
  originCommits: { sha: string; subject: string }[];
  sessionIds: string[];
  stopReason: 'completed' | 'refused' | 'exception' | 'timeout' | 'interrupted';
  errors: string[];
  gate?: GateEvidence | null;
}

export function parseDecisionLines(lines: string[]) {
  const decisions: FactoryDecisionLogLine[] = [];
  const invalidDecisionLines: { line: number; error: string }[] = [];
  lines.forEach((line, index) => {
    try {
      const parsed = FactoryDecisionLogLine.safeParse(JSON.parse(line));
      if (!parsed.success) { invalidDecisionLines.push({ line: index + 1, error: parsed.error.message }); return; }
      decisions.push(parsed.data);
    } catch (error) {
      invalidDecisionLines.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { decisions, invalidDecisionLines };
}

export async function readBuildOutput(directory: string): Promise<BuildOutput> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const filePaths = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const nestedFolderPaths = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(entry.parentPath, entry.name));
  return { directory, filePaths, folderPaths: [directory, ...nestedFolderPaths] };
}

function couldLandInBuildOutput(relativeArgument: string, buildOutput: BuildOutput): boolean {
  const tailSegments = path.posix.normalize(relativeArgument).split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (tailSegments.length === 0) return false;
  const pathTail = tailSegments.join('/');
  const candidatePaths = tailSegments.length === 1 ? buildOutput.filePaths : [...buildOutput.filePaths, ...buildOutput.folderPaths];
  return candidatePaths.some((candidatePath) => candidatePath.endsWith(`/${pathTail}`));
}

export function processesUsingBuildOutput(processes: readonly RunningProcess[], buildOutput: BuildOutput, harnessPid: number): RunningProcess[] {
  return processes.filter((candidate) => {
    if (candidate.pid === harnessPid) return false;
    if (candidate.command.includes(`${buildOutput.directory}/`)) return true;
    if (candidate.resolvedArguments.some((argument) => isPathInside(buildOutput.directory, argument))) return true;
    return candidate.unresolvedRelativeArguments.some((argument) => couldLandInBuildOutput(argument, buildOutput));
  });
}

export function pidsStillNamingSameProcess(recorded: readonly ProcessIdentity[], current: readonly ProcessIdentity[]): number[] {
  const currentStartByPid = new Map(current.map(({ pid, startedAt }) => [pid, startedAt]));
  return [...new Set(recorded.filter(({ pid, startedAt }) => startedAt !== '' && currentStartByPid.get(pid) === startedAt).map(({ pid }) => pid))];
}

export function unexpectedAcceptanceError(expectedEnd: ExpectedEnd, queueReply: FactoryQueueIntentResult | null): string | null {
  return expectedEnd === 'refused' && queueReply?.ok === true ? 'The factory accepted an intent it was expected to refuse' : null;
}

function isStallReport(projectError: string): boolean {
  const reportStart = projectError.indexOf('factory ');
  if (reportStart === -1) return false;
  return [matchedProductText.promptStall.text, matchedProductText.startupStall.text, matchedProductText.idleStall.text].some((stallText) => projectError.includes(stallText, reportStart + 'factory '.length));
}

export function decideVerdict(input: VerdictInput) {
  const gate = decideGate(input.gate ?? null);
  const hasGateBreach = gate?.held === false;
  const lacksGateProof = gate?.held === null && input.expectedEnd === 'completed';
  const { decisions, invalidDecisionLines } = parseDecisionLines(input.decisionLines);
  const projects = input.broadcasts.flatMap((broadcast) => {
    const project = broadcast.state.projects.find((candidate) => candidate.projectId === input.projectId);
    return project ? [{ ...broadcast, project }] : [];
  });
  const workId = input.queueReply?.workId;
  const relevantDecisions = decisions.filter((decision) => decision.projectId === input.projectId);
  const hasCompletedSteadily = projects.some(({ project }) => project.heading.action === 'steady' && project.orders.some((order) => order.id === workId && order.state === 'completed'));
  const merges = relevantDecisions.filter((decision) => decision.kind === 'merge' && decision.intentId === workId);
  const hasLandedCommits = merges.length > 0 && merges.every((decision) => decision.kind === 'merge' && input.originCommits.some((commit) => commit.sha === decision.mergedSha)) && input.originCommits.some((commit) => commit.subject === `${matchedProductText.verifyCloseSubject.text}${workId}`);
  const hasRefusal = input.queueReply?.ok === false;
  const queueReplyError = input.queueReply?.error ?? null;
  const hasExpectedRefusal = hasRefusal && input.expectedEnd === 'refused' && input.expectedRefusal !== null && (queueReplyError ?? '').includes(input.expectedRefusal);
  const hasPass = input.expectedEnd === 'refused' ? hasExpectedRefusal : hasCompletedSteadily && hasLandedCommits;
  const candidates: FailureClass[] = [];
  if (input.stopReason === 'interrupted') candidates.push('interrupted');
  if (hasRefusal && !hasExpectedRefusal) candidates.push('queue-refused');
  if (relevantDecisions.some((decision) => decision.failureClass === 'stall' || decision.outcome === 'stalled') || projects.some(({ project }) => isStallReport(project.error ?? ''))) candidates.push('stalled');
  if (relevantDecisions.some((decision) => decision.failureClass === 'check')) candidates.push('checks');
  if (relevantDecisions.some((decision) => decision.failureClass === 'review')) candidates.push('review');
  if (input.errors.length > 0 || input.stopReason === 'exception' || invalidDecisionLines.length > 0 || projects.some(({ project }) => project.error !== null) || relevantDecisions.some((decision) => ['raised', 'failed', 'block'].includes(decision.outcome))) candidates.push('exception');
  if (input.stopReason === 'timeout') candidates.push('timeout');
  const hasSuccessfulStop = input.expectedEnd === 'refused' ? input.stopReason === 'refused' : input.stopReason === 'completed';
  const hasCleanPass = hasSuccessfulStop && hasPass && input.errors.length === 0 && invalidDecisionLines.length === 0 && !projects.at(-1)?.project.error;
  const mostSpecificFailure = failurePrecedence.find((failure) => candidates.includes(failure)) ?? 'exception';
  const gateFailure = hasGateBreach || hasCleanPass ? 'exception' : mostSpecificFailure;
  const failureClass = hasCleanPass && !hasGateBreach && !lacksGateProof ? null : gateFailure;
  const gateReason = hasCleanPass && lacksGateProof ? 'Gate proof unavailable' : null;
  const startedMs = Date.parse(input.startedAt);
  const elapsed = (timestamp: string | null | undefined) => timestamp ? Math.max(0, Date.parse(timestamp) - startedMs) : null;
  const queued = projects.find(({ project }) => project.orders.some((order) => order.id === workId));
  const firstWorker = projects.find(({ project }) => (project.liveWorkers?.length ?? 0) > 0);
  const firstMerge = projects.find(({ project }) => project.orders.some((order) => order.parent === workId && order.state === 'completed'));
  const completed = projects.find(({ project }) => project.orders.some((order) => order.id === workId && order.state === 'completed'));
  const attemptsPerOrder: Record<string, number> = {};
  const sessions = new Set(input.sessionIds);
  for (const decision of relevantDecisions) {
    if (decision.workId && decision.attempt !== null) attemptsPerOrder[decision.workId] = Math.max(attemptsPerOrder[decision.workId] ?? 0, decision.attempt);
    if (decision.workId && decision.kind === 'admission' && decision.outcome === 'dispatched') attemptsPerOrder[decision.workId] = Math.max(attemptsPerOrder[decision.workId] ?? 0, relevantDecisions.filter((candidate) => candidate.kind === 'admission' && candidate.outcome === 'dispatched' && candidate.workId === decision.workId).length);
    if (decision.sessionId) sessions.add(decision.sessionId);
  }
  const lastProject = projects.at(-1)?.project;
  const orderIds = new Set(projects.flatMap(({ project }) => project.orders.map((order) => order.id)));
  for (const decision of relevantDecisions) if (decision.workId) orderIds.add(decision.workId);
  return {
    intentName: input.intentName, expectedEnd: input.expectedEnd, expectedRefusal: input.expectedRefusal, queueReplyError, outcome: failureClass === null ? 'pass' as const : 'fail' as const,
    failureClass, gate, reason: hasGateBreach ? 'The gate did not hold' : gateReason, startedAt: input.startedAt, endedAt: input.endedAt, durationMs: elapsed(input.endedAt),
    milestonesMs: { queued: input.queueReply?.ok ? elapsed(queued?.arrivedAt ?? input.queueRepliedAt) : null, firstWorkerDispatched: elapsed(firstWorker?.arrivedAt), firstMerge: elapsed(firstMerge?.arrivedAt), completed: elapsed(completed?.arrivedAt) },
    sessionCount: sessions.size, orderCount: orderIds.size, attemptsPerOrder, spendUsd: lastProject?.spentTodayUsd ?? null,
    invalidDecisionLineCount: invalidDecisionLines.length, invalidDecisionLines, errors: input.errors,
  };
}
export type Verdict = ReturnType<typeof decideVerdict>;

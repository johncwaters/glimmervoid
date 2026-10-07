const CODER_ACTIVITY_TICK_INTERVAL_MS = 60_000;
const CODER_ACTIVITY_HEARTBEAT_MS = 10 * 60_000;
const CODER_ACTIVITY_RETRY_MAX_WAIT_MS = 2 * 60_000;
const CODER_ACTIVITY_STOPPED_MESSAGE = 'Glimmervoid activity reporting stopped';

type CoderActivityState = 'working' | 'idle';
interface CoderActivityLastReport {
  state: CoderActivityState;
  at: number;
}

function decideCoderReport({ runningSessionCount, lastReport, now }: {
  runningSessionCount: number;
  lastReport: CoderActivityLastReport | null;
  now: number;
}): CoderActivityState | null {
  if (runningSessionCount === 0) return lastReport?.state === 'idle' ? null : 'idle';
  if (lastReport === null || lastReport.state === 'idle') return 'working';
  if (now - lastReport.at >= CODER_ACTIVITY_HEARTBEAT_MS) return 'working';
  return null;
}

function coderActivityShouldStart({ appSlug, agentUrl, agentToken, agentTokenFile }: {
  appSlug?: string;
  agentUrl?: string;
  agentToken?: string;
  agentTokenFile?: string;
}): { start: boolean; reason?: string } {
  if (!appSlug?.trim()) return { start: false };
  if (!agentUrl?.trim()) return { start: false, reason: 'Missing CODER_AGENT_URL' };
  if (!agentToken?.trim() && !agentTokenFile?.trim()) return { start: false, reason: 'Missing CODER_AGENT_TOKEN or CODER_AGENT_TOKEN_FILE' };
  return { start: true };
}

function buildCoderActivityMessage(runningSessionCount: number): string {
  if (runningSessionCount === 0) return 'No Glimmervoid sessions running';
  if (runningSessionCount === 1) return '1 Glimmervoid session running';
  return `${runningSessionCount} Glimmervoid sessions running`;
}

export {
  CODER_ACTIVITY_TICK_INTERVAL_MS, CODER_ACTIVITY_HEARTBEAT_MS, CODER_ACTIVITY_RETRY_MAX_WAIT_MS, CODER_ACTIVITY_STOPPED_MESSAGE, decideCoderReport, coderActivityShouldStart, buildCoderActivityMessage,
};
export type { CoderActivityState, CoderActivityLastReport };

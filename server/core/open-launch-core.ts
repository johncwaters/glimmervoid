type ProbeReply = { kind: 'answered'; status: number; body: unknown } | { kind: 'failed'; failureCode: string | null };
type ProbeOutcome = 'glimmervoid' | 'foreign' | 'busy' | 'free';
type LaunchPhase = 'probing' | 'starting';
type LaunchFailure = 'port-foreign' | 'port-unresponsive' | 'child-exited' | 'timed-out';
type LaunchStep =
  | { kind: 'open-dashboard' }
  | { kind: 'start-server' }
  | { kind: 'keep-waiting' }
  | { kind: 'fail'; failure: LaunchFailure };

const LAUNCH_PROBE_INTERVAL_MS = 250;
const LAUNCH_START_TIMEOUT_MS = 60_000;
const LAUNCH_PROBE_TIMEOUT_MS = 5_000;
const LAUNCH_DIALOG_TITLE = 'Glimmervoid';
const LAUNCH_OPENER_HOLD_MS = 5_000;
const PROBE_TIMEOUT_FAILURE_CODE = 'TIMEOUT';

function isGlimmervoidTokenBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return typeof (body as { token?: unknown }).token === 'string';
}

function classifyProbe(reply: ProbeReply): ProbeOutcome {
  if (reply.kind === 'failed' && reply.failureCode === 'ECONNREFUSED') return 'free';
  if (reply.kind === 'failed' && reply.failureCode === PROBE_TIMEOUT_FAILURE_CODE) return 'busy';
  if (reply.kind === 'failed') return 'foreign';
  if (reply.status === 200 && isGlimmervoidTokenBody(reply.body)) return 'glimmervoid';
  return 'foreign';
}

function decideProbingStep(outcome: ProbeOutcome, isPastDeadline: boolean): LaunchStep {
  if (outcome === 'foreign') return { kind: 'fail', failure: 'port-foreign' };
  if (outcome === 'free') return { kind: 'start-server' };
  if (isPastDeadline) return { kind: 'fail', failure: 'port-unresponsive' };
  return { kind: 'keep-waiting' };
}

function decideLaunchStep({ phase, outcome, hasChildExited, elapsedMs }: { phase: LaunchPhase; outcome: ProbeOutcome; hasChildExited: boolean; elapsedMs: number }): LaunchStep {
  if (outcome === 'glimmervoid') return { kind: 'open-dashboard' };
  const isPastDeadline = elapsedMs >= LAUNCH_START_TIMEOUT_MS;
  if (phase === 'probing') return decideProbingStep(outcome, isPastDeadline);
  if (hasChildExited) return { kind: 'fail', failure: 'child-exited' };
  if (isPastDeadline) return { kind: 'fail', failure: 'timed-out' };
  return { kind: 'keep-waiting' };
}

function dashboardUrlForPort(port: number): string {
  return `http://localhost:${port}`;
}

function launchFailureText(failure: LaunchFailure, port: number, logPath: string): string {
  if (failure === 'port-unresponsive') return `Something on port ${port} accepts connections but does not answer. If it is Glimmervoid, it may be busy: wait a moment and open it again.`;
  if (failure === 'port-foreign') return `Port ${port} is used by another program, so Glimmervoid cannot start there. Close that program, or set another port in Glimmervoid's settings.`;
  if (failure === 'child-exited') return `Glimmervoid stopped while starting. The reason is in ${logPath}`;
  return `Glimmervoid did not start within ${LAUNCH_START_TIMEOUT_MS / 1000} seconds. The reason may be in ${logPath}`;
}

function powershellLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function windowsPopupScript(title: string, text: string): string {
  return `(New-Object -ComObject WScript.Shell).Popup(${powershellLiteral(text)}, 0, ${powershellLiteral(title)}, 16) | Out-Null`;
}

function pangoEscaped(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function dialogCommandsFor(platform: string, title: string, text: string): string[][] {
  if (platform === 'darwin') {
    return [['osascript', '-e', 'on run argv', '-e', 'display alert (item 1 of argv) message (item 2 of argv) as critical', '-e', 'end run', title, text]];
  }
  if (platform === 'win32') {
    const encodedScript = Buffer.from(windowsPopupScript(title, text), 'utf16le').toString('base64');
    return [['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript]];
  }
  return [['zenity', '--error', '--title', title, '--text', pangoEscaped(text)], ['notify-send', '--urgency=critical', title, text]];
}

export {
  LAUNCH_DIALOG_TITLE,
  LAUNCH_OPENER_HOLD_MS,
  LAUNCH_PROBE_INTERVAL_MS,
  LAUNCH_PROBE_TIMEOUT_MS,
  classifyProbe,
  PROBE_TIMEOUT_FAILURE_CODE,
  dashboardUrlForPort,
  decideLaunchStep,
  dialogCommandsFor,
  launchFailureText,
};
export type { LaunchFailure, LaunchPhase, ProbeOutcome, ProbeReply };

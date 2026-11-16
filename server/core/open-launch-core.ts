import path from 'node:path';

type ProbeReply = { kind: 'answered'; status: number; body: unknown } | { kind: 'failed'; failureCode: string | null };
type ProbeOutcome = 'glimmervoid' | 'foreign' | 'busy' | 'free';
type LaunchPhase = 'probing' | 'starting';
type LaunchFailure = 'port-foreign' | 'port-unresponsive' | 'child-exited' | 'timed-out';
type AppWindowCandidate = { installedPath: string; command: string; leadingArgs: readonly string[] };
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
const LAUNCH_STARTING_TEXT = 'Starting Glimmervoid. The dashboard opens when it is ready.';
const MAC_CHROMIUM_APP_NAMES = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
const LINUX_CHROMIUM_COMMAND_NAMES = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'chromium', 'chromium-browser'];
const WINDOWS_CHROMIUM_EXECUTABLES = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ['Chromium', 'Application', 'chrome.exe'],
];
const WINDOWS_PROGRAM_ROOT_VARIABLES = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];

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

function macAppWindowCandidates(homeDir: string): AppWindowCandidate[] {
  return MAC_CHROMIUM_APP_NAMES.flatMap((appName) => ['/Applications', path.posix.join(homeDir, 'Applications')].map((applicationsDir) => {
    const installedPath = path.posix.join(applicationsDir, `${appName}.app`);
    return { installedPath, command: 'open', leadingArgs: ['-na', installedPath, '--args'] };
  }));
}

function windowsAppWindowCandidates(env: Readonly<Record<string, string | undefined>>): AppWindowCandidate[] {
  const programRoots = WINDOWS_PROGRAM_ROOT_VARIABLES.flatMap((variableName) => env[variableName] ?? []);
  return WINDOWS_CHROMIUM_EXECUTABLES.flatMap((executableParts) => programRoots.map((programRoot) => {
    const installedPath = path.win32.join(programRoot, ...executableParts);
    return { installedPath, command: installedPath, leadingArgs: [] };
  }));
}

function linuxAppWindowCandidates(env: Readonly<Record<string, string | undefined>>): AppWindowCandidate[] {
  const pathDirs = (env.PATH ?? '').split(':').filter((pathDir) => pathDir !== '');
  return LINUX_CHROMIUM_COMMAND_NAMES.flatMap((commandName) => pathDirs.map((pathDir) => {
    const installedPath = path.posix.join(pathDir, commandName);
    return { installedPath, command: installedPath, leadingArgs: [] };
  }));
}

function appWindowCandidatesFor({ platform, env, homeDir }: { platform: string; env: Readonly<Record<string, string | undefined>>; homeDir: string }): AppWindowCandidate[] {
  if (platform === 'darwin') return macAppWindowCandidates(homeDir);
  if (platform === 'win32') return windowsAppWindowCandidates(env);
  if (platform === 'linux') return linuxAppWindowCandidates(env);
  return [];
}

function appWindowArgv(candidate: AppWindowCandidate, dashboardUrl: string): string[] {
  return [candidate.command, ...candidate.leadingArgs, `--app=${dashboardUrl}`];
}

function powershellLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function windowsPopupScript(title: string, text: string): string {
  return `(New-Object -ComObject WScript.Shell).Popup(${powershellLiteral(text)}, 0, ${powershellLiteral(title)}, 16) | Out-Null`;
}

function windowsToastScript(title: string, text: string): string {
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$lines = $template.GetElementsByTagName('text')",
    `$lines.Item(0).AppendChild($template.CreateTextNode(${powershellLiteral(title)})) | Out-Null`,
    `$lines.Item(1).AppendChild($template.CreateTextNode(${powershellLiteral(text)})) | Out-Null`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($template))",
  ].join('\n');
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

function notificationCommandsFor(platform: string, title: string, text: string): string[][] {
  if (platform === 'darwin') {
    return [['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text]];
  }
  if (platform === 'win32') {
    const encodedScript = Buffer.from(windowsToastScript(title, text), 'utf16le').toString('base64');
    return [['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript]];
  }
  return [['notify-send', title, text]];
}

export {
  LAUNCH_DIALOG_TITLE,
  LAUNCH_STARTING_TEXT,
  appWindowArgv,
  appWindowCandidatesFor,
  notificationCommandsFor,
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
export type { AppWindowCandidate, LaunchFailure, LaunchPhase, ProbeOutcome, ProbeReply };

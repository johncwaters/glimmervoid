import fs from 'node:fs';
import path from 'node:path';
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { generateProxyEnvVars } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js';
import { spawn } from '../child-process-safe.ts';
import { errorMessage } from '../../shared/text.ts';
import { buildSeatbeltProfile } from './core/seatbelt-profile-core.ts';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = Object.freeze(['SIGTERM', 'SIGHUP']);
const TERMINAL_SIGNALS_THE_CHILD_ALREADY_GETS: readonly NodeJS.Signals[] = Object.freeze(['SIGINT', 'SIGQUIT']);

interface LauncherArguments {
  settingsPath: string;
  ingressPort: number;
  agentTempFolder: string;
  readableLinks: string[];
  file: string;
  args: string[];
}

function launcherArgumentsOf(argv: readonly string[]): LauncherArguments | { refusal: string } {
  const [settingsPath, ingressPortText, agentTempFolder, linkCountText, ...rest] = argv;
  const ingressPort = Number(ingressPortText);
  const linkCount = Number(linkCountText);
  if (!settingsPath || !agentTempFolder || !Number.isInteger(ingressPort) || !Number.isInteger(linkCount) || linkCount < 0) return { refusal: 'usage: seatbelt-launcher <srt.json> <ingress port> <agent temp folder> <link count> <link>... <file> <arg>...' };
  const readableLinks = rest.slice(0, linkCount);
  const [file, ...args] = rest.slice(linkCount);
  if (!file) return { refusal: 'no command to launch' };
  return { settingsPath, ingressPort, agentTempFolder, readableLinks, file, args };
}

function nearestRealPath(entryPath: string): string {
  const resolved = path.resolve(entryPath);
  const real = (() => { try { return fs.realpathSync(resolved); } catch { return null; } })();
  if (real !== null) return real;
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(nearestRealPath(parent), path.basename(resolved));
}

type FilesystemEntry = string | { path: string };

function spellingsOf(entries: readonly FilesystemEntry[]): string[] {
  const entryPaths = entries.map((entry) => typeof entry === 'string' ? entry : entry.path);
  return [...new Set(entryPaths.flatMap((entryPath) => [path.resolve(entryPath), nearestRealPath(entryPath)]))];
}

function linkSpellingsOf(linkPaths: readonly string[]): string[] {
  return [...new Set(linkPaths.flatMap((linkPath) => [path.resolve(linkPath), path.join(nearestRealPath(path.dirname(linkPath)), path.basename(linkPath))]))];
}

function envFromAssignments(assignments: readonly string[]): Record<string, string> {
  return Object.fromEntries(assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    return [assignment.slice(0, separator), assignment.slice(separator + 1)];
  }));
}

function refuse(reason: string): never {
  process.stderr.write(`glimmervoid sandbox: ${reason}\n`);
  process.exit(1);
}

async function launch(argv: readonly string[]): Promise<void> {
  const launcherArguments = launcherArgumentsOf(argv);
  if ('refusal' in launcherArguments) return refuse(launcherArguments.refusal);
  const settingsText = (() => { try { return fs.readFileSync(launcherArguments.settingsPath, 'utf8'); } catch { return null; } })();
  if (settingsText === null) return refuse(`cannot read ${launcherArguments.settingsPath}`);
  const parsedSettings = SandboxRuntimeConfigSchema.safeParse((() => { try { return JSON.parse(settingsText); } catch { return null; } })());
  if (!parsedSettings.success) return refuse(`${launcherArguments.settingsPath} is not a valid sandbox settings file`);
  const settings = parsedSettings.data;
  const signalsTheLauncherOwns = [...FORWARDED_SIGNALS, ...TERMINAL_SIGNALS_THE_CHILD_ALREADY_GETS];
  const listenersBeforeInitialize = new Map(signalsTheLauncherOwns.map((signal) => [signal, new Set(process.listeners(signal))]));
  await SandboxManager.initialize(settings);
  for (const signal of signalsTheLauncherOwns) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBeforeInitialize.get(signal)?.has(listener)) process.off(signal, listener);
    }
  }
  const httpProxyPort = SandboxManager.getProxyPort();
  const socksProxyPort = SandboxManager.getSocksProxyPort();
  if (httpProxyPort === undefined) return refuse('the sandbox network proxy did not start');
  const filesystem = settings.filesystem;
  const profile = buildSeatbeltProfile({
    denyRead: spellingsOf(filesystem.denyRead),
    allowRead: spellingsOf(filesystem.allowRead ?? []),
    readableLinks: linkSpellingsOf(launcherArguments.readableLinks),
    allowWrite: spellingsOf(filesystem.allowWrite),
    denyWrite: spellingsOf(filesystem.denyWrite),
    worktree: nearestRealPath(process.cwd()),
    loopbackPorts: [launcherArguments.ingressPort, httpProxyPort, ...(socksProxyPort === undefined ? [] : [socksProxyPort])],
  });
  const proxyEnv = envFromAssignments(generateProxyEnvVars(httpProxyPort, socksProxyPort, undefined, SandboxManager.getProxyAuthToken(), true));
  const child = spawn(SANDBOX_EXEC_PATH, ['-p', profile, launcherArguments.file, ...launcherArguments.args], {
    stdio: 'inherit',
    env: { ...process.env, ...proxyEnv, TMPDIR: launcherArguments.agentTempFolder },
  });
  const forwardSignal = (signal: NodeJS.Signals) => { child.kill(signal); };
  const ignoreSignal = () => undefined;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forwardSignal);
  for (const signal of TERMINAL_SIGNALS_THE_CHILD_ALREADY_GETS) process.on(signal, ignoreSignal);
  child.on('error', (error) => refuse(`${SANDBOX_EXEC_PATH} did not start: ${error.message}`));
  child.on('exit', (exitCode, signal) => {
    for (const forwarded of FORWARDED_SIGNALS) process.off(forwarded, forwardSignal);
    for (const terminalSignal of TERMINAL_SIGNALS_THE_CHILD_ALREADY_GETS) process.off(terminalSignal, ignoreSignal);
    const exitLikeChild = () => {
      if (signal !== null) process.kill(process.pid, signal);
      process.exit(exitCode ?? 1);
    };
    void SandboxManager.reset().then(exitLikeChild, exitLikeChild);
  });
}

if (process.argv[1] === import.meta.filename) {
  launch(process.argv.slice(2)).catch((error: unknown) => refuse(errorMessage(error)));
}

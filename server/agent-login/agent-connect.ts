import fs from 'node:fs/promises';
import pty from 'node-pty';
import { requireExecutableSpawnHelper } from '../node-pty-preflight.ts';
import {
  CONNECT_RECIPES, CONNECT_TIMEOUT_MS, appendConnectOutput, connectHomeDir, connectingStatus, decideConnectExit, idleLoginStatus,
  pastedCodeRefusal, pastedCodeRejection, readConnectPrompt,
} from './core/agent-connect-core.ts';
import type { LoginSource } from './core/agent-connect-core.ts';
import type { AgentLoginStatus, ConnectableAgent } from '../../shared/contracts/control-messages.ts';

const CONNECTABLE_AGENTS: readonly ConnectableAgent[] = Object.freeze(['claude-code', 'codex']);

interface ConnectPty {
  onData: (listener: (data: string) => void) => unknown;
  onExit: (listener: (event: { exitCode: number }) => void) => unknown;
  write: (data: string) => void;
  kill: () => void;
}

type ConnectPtySpawn = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => ConnectPty;

interface ConnectLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface AgentConnectOptions {
  loginsRoot: string;
  loginSource: (agent: ConnectableAgent) => Promise<LoginSource | null>;
  launchFor: (agent: ConnectableAgent, loginArgs: string[]) => ConnectLaunch | null;
  onChange: (logins: AgentLoginStatus[]) => void;
  ptySpawn?: ConnectPtySpawn;
  makeHomeDir?: (directory: string) => Promise<void>;
  setTimeoutFn?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface RunningConnect {
  terminal: ConnectPty;
  output: string;
  outputSincePastedCode: string | null;
  wasCancelled: boolean;
  hasTimedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
}

type ConnectReply = { ok: true } | { ok: false; error: string };

function spawnConnectPty(file: string, args: string[], options: Parameters<ConnectPtySpawn>[2]): ConnectPty {
  requireExecutableSpawnHelper();
  return pty.spawn(file, args, options);
}

async function makePrivateDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

function createAgentConnect({
  loginsRoot,
  loginSource,
  launchFor,
  onChange,
  ptySpawn = spawnConnectPty,
  makeHomeDir = makePrivateDir,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: AgentConnectOptions) {
  const statusByAgent = new Map<ConnectableAgent, AgentLoginStatus>(CONNECTABLE_AGENTS.map((agent) => [agent, idleLoginStatus(agent, null)]));
  const runningByAgent = new Map<ConnectableAgent, RunningConnect>();

  function logins(): AgentLoginStatus[] {
    return CONNECTABLE_AGENTS.map((agent) => statusByAgent.get(agent) ?? idleLoginStatus(agent, null));
  }

  function setStatus(agent: ConnectableAgent, status: AgentLoginStatus): void {
    const previous = statusByAgent.get(agent);
    statusByAgent.set(agent, status);
    if (JSON.stringify(previous) !== JSON.stringify(status)) onChange(logins());
  }

  async function refresh(): Promise<AgentLoginStatus[]> {
    await Promise.all(CONNECTABLE_AGENTS.map(async (agent) => {
      if (runningByAgent.has(agent)) return;
      const source = await loginSource(agent).catch(() => null);
      if (runningByAgent.has(agent)) return;
      const current = statusByAgent.get(agent);
      if (current?.state === 'failed' && source === null) return;
      setStatus(agent, idleLoginStatus(agent, source));
    }));
    return logins();
  }

  async function finish(agent: ConnectableAgent, running: RunningConnect, exitCode: number): Promise<void> {
    clearTimeoutFn(running.timer);
    const source = await loginSource(agent).catch(() => null);
    runningByAgent.delete(agent);
    setStatus(agent, decideConnectExit({ agent, exitCode, source, wasCancelled: running.wasCancelled, hasTimedOut: running.hasTimedOut }));
  }

  async function start(agent: ConnectableAgent): Promise<ConnectReply> {
    if (runningByAgent.has(agent)) return { ok: true };
    const recipe = CONNECT_RECIPES[agent];
    const launch = launchFor(agent, recipe.loginArgs);
    if (!launch) return { ok: false, error: `The ${recipe.displayName} command could not be found on this machine.` };
    const homeDir = connectHomeDir(loginsRoot, agent);
    try {
      await makeHomeDir(homeDir);
    } catch (error) {
      return { ok: false, error: `Could not create ${homeDir}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (runningByAgent.has(agent)) return { ok: true };
    let terminal: ConnectPty;
    try {
      terminal = ptySpawn(launch.file, launch.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: homeDir, env: { ...launch.env, [recipe.homeEnvKey]: homeDir } });
    } catch (error) {
      return { ok: false, error: `${recipe.displayName} sign-in did not start: ${error instanceof Error ? error.message : String(error)}` };
    }
    const running: RunningConnect = {
      terminal,
      output: '',
      outputSincePastedCode: null,
      wasCancelled: false,
      hasTimedOut: false,
      timer: setTimeoutFn(() => {
        running.hasTimedOut = true;
        terminal.kill();
      }, CONNECT_TIMEOUT_MS),
    };
    runningByAgent.set(agent, running);
    setStatus(agent, connectingStatus(agent, readConnectPrompt(agent, ''), null));
    terminal.onData((chunk) => {
      running.output = appendConnectOutput(running.output, chunk);
      if (running.outputSincePastedCode !== null) running.outputSincePastedCode = appendConnectOutput(running.outputSincePastedCode, chunk);
      if (runningByAgent.get(agent) !== running) return;
      setStatus(agent, connectingStatus(agent, readConnectPrompt(agent, running.output), pastedCodeRejection(agent, running.outputSincePastedCode)));
    });
    terminal.onExit(({ exitCode }) => { void finish(agent, running, exitCode); });
    return { ok: true };
  }

  function cancel(agent: ConnectableAgent): ConnectReply {
    const running = runningByAgent.get(agent);
    if (!running) return { ok: true };
    running.wasCancelled = true;
    running.terminal.kill();
    return { ok: true };
  }

  function submitCode(agent: ConnectableAgent, code: string): ConnectReply {
    const running = runningByAgent.get(agent);
    const status = statusByAgent.get(agent);
    if (!running || status?.state !== 'connecting' || !status.needsPastedCode) return { ok: false, error: `${CONNECT_RECIPES[agent].displayName} is not waiting for a code.` };
    const refusal = pastedCodeRefusal(code);
    if (refusal) return { ok: false, error: refusal };
    running.outputSincePastedCode = '';
    setStatus(agent, { ...status, reason: null });
    running.terminal.write(`${code.trim()}\r`);
    return { ok: true };
  }

  function stop(): void {
    for (const agent of runningByAgent.keys()) cancel(agent);
  }

  return { cancel, logins, refresh, start, stop, submitCode };
}

export { createAgentConnect };

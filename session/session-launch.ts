import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../shared/text.ts";
import { AGENT_URL_ENV } from "../shared/contracts/session.ts";
import { safePathSegment } from "../shared/paths.ts";
import { buildHookSettings } from "../detection/settings-injector.ts";
import { commandFor } from "./adapters/index.ts";
import { AUTO_CONTINUE_PROMPT } from "./core/auto-resume.ts";
import type { AgentAdapter } from "./adapters/index.ts";
import { startCoderPortForward } from "./codex-app-server-bridge.ts";
import type { CodexAppServerBridge, startCodexAppServerBridge } from "./codex-app-server-bridge.ts";
import { remoteCodexAppServerScript } from "./core/codex-app-server-core.ts";
import { remoteTuiArgs, splitCodexRemoteLaunch } from "./core/codex-remote-launch-core.ts";
import { commitSigningEnv } from "./core/commit-signing-env.ts";
import { CLAUDE_TOKEN_ALIAS_ENV, CLAUDE_TOKEN_ALIASES, CODER_SSH_ENV, coderSshArgs, coderSshExecArgs, encodeCoderSshEnv, remoteLaunchScript } from "./core/remote-launch-core.ts";
import type { ResolvedCommand } from "./core/spawn-command.ts";
import type { SpawnEnv } from "./core/spawn-env.ts";
import type { createSessionHookLifecycle } from "./session-hook-lifecycle.ts";

type RemoteLaunchStep = { ok: true } | { ok: false; reason: string };

interface RemoteLaunch {
  workspace: string;
  remotePort: number;
  checkoutDirectory: string;
  nodePath: string;
  ensureRunning: () => Promise<RemoteLaunchStep>;
  describeExit: () => Promise<string | null>;
  uploadFile: (file: { remotePath: string; contents: string; mode: number }) => Promise<void>;
  claudeToken: () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
  codexVersion: () => Promise<string | null>;
  codexLoginParams: () => Promise<unknown>;
  codexRefreshResult: () => Promise<unknown>;
}

const REMOTE_CODEX_STARTUP_TIMEOUT_MS = 300_000;

type RemoteSpawnFailureCode =
  | "REMOTE_HOOKS_UNAVAILABLE"
  | "REMOTE_WORKSPACE_UNAVAILABLE"
  | "REMOTE_CLAUDE_LOGIN_FAILED"
  | "REMOTE_SETTINGS_UPLOAD_FAILED"
  | "REMOTE_LAUNCH_COMMAND_UNBUILDABLE"
  | "REMOTE_CODEX_VERSION_UNREADABLE"
  | "REMOTE_CODEX_BRIDGE_FAILED"
  | "REMOTE_SPAWN_FAILED";

interface RemoteSpawnFailure {
  ok: false;
  code: RemoteSpawnFailureCode;
  reason: string;
}

function remoteSpawnFailure(code: RemoteSpawnFailureCode, reason: string): RemoteSpawnFailure {
  return { ok: false, code, reason };
}

async function runRemoteStep<Success extends { ok: true }>(
  code: RemoteSpawnFailureCode,
  run: () => Promise<Success | { ok: false; reason: string }>,
): Promise<Success | RemoteSpawnFailure> {
  const outcome = await run().catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error) }));
  if (outcome.ok) return outcome;
  return remoteSpawnFailure(code, outcome.reason);
}

function remoteSpawnError(workspace: string, failure: RemoteSpawnFailure): Error {
  return Object.assign(new Error(`Coder workspace ${workspace}: ${failure.reason}`), { code: failure.code });
}

interface SpawnCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

type LaunchHooks = Pick<ReturnType<typeof createSessionHookLifecycle>, "token" | "listenerPort" | "cleanup">;

interface LaunchPort {
  name: () => string;
  promptSupervisionLine: () => string | null;
  effectiveCwd: () => string;
  spawnEnv: () => Record<string, string> | null;
  spawnCommand: () => ResolvedCommand | null;
  agentToken: () => string | null;
  commitSigningToken: () => string | null;
  commitSigningProgram: () => string | null;
  isDestroyed: () => boolean;
  abandonSpawn: (cause: unknown) => void;
  emit: (event: string, detail: Record<string, unknown>) => void;
  forceRestart: (options: { resumePrompt: string }) => boolean;
}

interface SessionLaunchOptions {
  id: string;
  adapter: AgentAdapter;
  platform: NodeJS.Platform;
  startCodexBridge: typeof startCodexAppServerBridge;
  getRemoteLaunch: () => RemoteLaunch | null;
  hooks: LaunchHooks;
  port: LaunchPort;
}

interface SessionLaunch {
  buildEnv(options?: { extraEnv?: Record<string, string> | null; prependPathDirs?: readonly string[] }): SpawnEnv;
  agentApiEnv(): Record<string, string>;
  commitSigningEnv(): Record<string, string>;
  spawnCwdSpellings(): string[];
  spawnCommandFor(input: {
    remoteLaunch: RemoteLaunch | null;
    isRemoteCodex: boolean;
    settingsArgs: string[];
    agentArgs: string[];
    bridgedLaunch: { tuiArgs: string[]; token: string } | null;
  }): Promise<SpawnCommand | null>;
  startRemoteCodexBridge(remote: RemoteLaunch, agentArgs: string[], env: SpawnEnv): Promise<{ tuiArgs: string[]; token: string } | null>;
  stopCodexBridge(): Promise<void>;
  respawnAfterAuthFailure(): boolean;
  noteTurnStopped(): void;
}

function createSessionLaunch({ id, adapter, platform, startCodexBridge, getRemoteLaunch, hooks, port }: SessionLaunchOptions): SessionLaunch {
  let codexBridge: CodexAppServerBridge | null = null;
  let hasRespawnedForAuth = false;

  function agentApiEnv(): Record<string, string> {
    const agentToken = port.agentToken();
    if (!agentToken) return {};
    const listenerPort = hooks.listenerPort();
    if (!listenerPort) return {};
    const url = `http://127.0.0.1:${listenerPort}/agent/${encodeURIComponent(id)}?t=${encodeURIComponent(agentToken)}`;
    return { [AGENT_URL_ENV]: url };
  }

  function signingEnv(): Record<string, string> {
    if (getRemoteLaunch() !== null) return {};
    return commitSigningEnv({
      port: hooks.listenerPort(),
      sessionId: id,
      token: port.commitSigningToken(),
      signingProgram: port.commitSigningProgram(),
      inheritedConfigParameters: port.spawnEnv()?.GIT_CONFIG_PARAMETERS ?? process.env.GIT_CONFIG_PARAMETERS,
    });
  }

  function spawnCwdSpellings(): string[] {
    const spawnCwd = port.effectiveCwd();
    try {
      return Array.from(new Set([spawnCwd, fs.realpathSync.native(spawnCwd)]));
    } catch {
      return [spawnCwd];
    }
  }

  async function stopCodexBridge(): Promise<void> {
    const bridge = codexBridge;
    if (!bridge) return;
    codexBridge = null;
    await bridge.stop().catch((error: unknown) => console.warn(`[session:${port.name()}] codex app-server stop failed: ${errorMessage(error)}`));
  }

  async function spawnCommandFor({ remoteLaunch, isRemoteCodex, settingsArgs, agentArgs, bridgedLaunch }: {
    remoteLaunch: RemoteLaunch | null;
    isRemoteCodex: boolean;
    settingsArgs: string[];
    agentArgs: string[];
    bridgedLaunch: { tuiArgs: string[]; token: string } | null;
  }): Promise<SpawnCommand | null> {
    if (remoteLaunch !== null && !isRemoteCodex) return remoteSpawnCommand(remoteLaunch, agentArgs);
    const command = adapter.buildSpawnCommand({
      platform: platform,
      resolved: port.spawnCommand() || commandFor(adapter),
      settingsArgs: bridgedLaunch ? [] : settingsArgs,
      agentArgs: bridgedLaunch?.tuiArgs ?? agentArgs,
    });
    return { file: command.file, args: command.args, env: {} };
  }

  async function startRemoteCodexBridge(remote: RemoteLaunch, agentArgs: string[], env: SpawnEnv): Promise<{ tuiArgs: string[]; token: string } | null> {
    await stopCodexBridge();
    const prepared = await prepareRemoteCodexBridge(remote, agentArgs, env).catch((error: unknown) => remoteSpawnFailure("REMOTE_SPAWN_FAILED", errorMessage(error)));
    if (port.isDestroyed()) {
      hooks.cleanup();
      await stopCodexBridge();
      return null;
    }
    if (!prepared.ok) {
      port.abandonSpawn(remoteSpawnError(remote.workspace, prepared));
      return null;
    }
    return prepared.launch;
  }

  async function prepareRemoteCodexBridge(remote: RemoteLaunch, agentArgs: string[], env: SpawnEnv): Promise<{ ok: true; launch: { tuiArgs: string[]; token: string } } | RemoteSpawnFailure> {
    const running = await runRemoteStep("REMOTE_WORKSPACE_UNAVAILABLE", remote.ensureRunning);
    if (!running.ok) return running;
    const version = await remote.codexVersion();
    if (version === null) return remoteSpawnFailure("REMOTE_CODEX_VERSION_UNREADABLE", "the host codex version could not be read, so the workspace cannot install a matching codex");
    const launch = splitCodexRemoteLaunch(agentArgs, port.promptSupervisionLine());
    const started = await runRemoteStep("REMOTE_CODEX_BRIDGE_FAILED", async () => ({ ok: true as const, bridge: await startCodexBridge({
      command: { file: "coder", argsBeforeAppServer: [] },
      configArgs: launch.appServerConfigArgs,
      cwd: port.effectiveCwd(),
      env: { ...env },
      tokenParentDirectory: os.tmpdir(),
      startupTimeoutMs: REMOTE_CODEX_STARTUP_TIMEOUT_MS,
      remote: {
        launch: (appServerArgs) => {
          const script = remoteCodexAppServerScript({ version, workingDirectory: remote.checkoutDirectory, appServerArgs });
          const sshArgs = script === null ? null : coderSshExecArgs({ workspace: remote.workspace, remoteCommand: script });
          if (sshArgs === null) throw new Error("the remote Codex app-server command could not be built");
          return { file: "coder", args: sshArgs };
        },
        forward: (remotePort) => startCoderPortForward({ workspace: remote.workspace, remotePort }),
        login: remote.codexLoginParams,
        refreshLogin: remote.codexRefreshResult,
      },
    }) }));
    if (!started.ok) return started;
    attachCodexBridge(started.bridge);
    return { ok: true, launch: { tuiArgs: remoteTuiArgs(started.bridge.url, launch.tuiArgs), token: started.bridge.token } };
  }

  function attachCodexBridge(bridge: CodexAppServerBridge): void {
    codexBridge = bridge;
    bridge.on("records", (records: unknown) => port.emit("conversation-records", { records }));
    bridge.on("error", (error: unknown) => console.warn(`[session:${port.name()}] codex app-server bridge: ${errorMessage(error)}`));
    bridge.on("exit", () => {
      if (codexBridge !== bridge) return;
      codexBridge = null;
    });
  }

  async function remoteSpawnCommand(remote: RemoteLaunch, agentArgs: string[]): Promise<SpawnCommand | null> {
    const prepared = await prepareRemoteSpawn(remote, agentArgs).catch((error: unknown) => remoteSpawnFailure("REMOTE_SPAWN_FAILED", errorMessage(error)));
    if (port.isDestroyed()) {
      hooks.cleanup();
      return null;
    }
    if (!prepared.ok) {
      port.abandonSpawn(remoteSpawnError(remote.workspace, prepared));
      return null;
    }
    return prepared.spawnCommand;
  }

  async function prepareRemoteSpawn(remote: RemoteLaunch, agentArgs: string[]): Promise<{ ok: true; spawnCommand: SpawnCommand } | RemoteSpawnFailure> {
    const hookToken = hooks.token();
    const ingressPort = hooks.listenerPort();
    if (hookToken === null || ingressPort === null) return remoteSpawnFailure("REMOTE_HOOKS_UNAVAILABLE", "hooks are unavailable, so the remote session could not report its status");
    const running = await runRemoteStep("REMOTE_WORKSPACE_UNAVAILABLE", remote.ensureRunning);
    if (!running.ok) return running;
    const login = await runRemoteStep("REMOTE_CLAUDE_LOGIN_FAILED", remote.claudeToken);
    if (!login.ok) return login;
    const settingsPath = path.posix.join(path.posix.dirname(remote.checkoutDirectory), ".glimmervoid-sessions", safePathSegment(id), "settings.json");
    const settings = buildHookSettings({ port: remote.remotePort, glimmervoidId: id, token: hookToken, remoteNodePath: remote.nodePath });
    const uploaded = await runRemoteStep("REMOTE_SETTINGS_UPLOAD_FAILED", async () => {
      await remote.uploadFile({ remotePath: settingsPath, contents: JSON.stringify(settings), mode: 0o600 });
      return { ok: true as const };
    });
    if (!uploaded.ok) return uploaded;
    const remoteCommand = remoteLaunchScript({
      workingDirectory: remote.checkoutDirectory,
      argv: ["claude", ...(adapter.settingsArgs?.(settingsPath) ?? []), ...agentArgs],
      tokenAliases: CLAUDE_TOKEN_ALIASES,
    });
    const sshArgs = remoteCommand === null ? null : coderSshArgs({ workspace: remote.workspace, remotePort: remote.remotePort, ingressPort, remoteCommand });
    const sshEnv = encodeCoderSshEnv({ [CLAUDE_TOKEN_ALIAS_ENV]: login.token });
    if (sshArgs === null || sshEnv === null) return remoteSpawnFailure("REMOTE_LAUNCH_COMMAND_UNBUILDABLE", "the remote launch command could not be built");
    return { ok: true, spawnCommand: { file: "coder", args: sshArgs, env: { [CODER_SSH_ENV]: sshEnv } } };
  }

  function respawnAfterAuthFailure(): boolean {
    if (getRemoteLaunch() === null || hasRespawnedForAuth) return false;
    hasRespawnedForAuth = true;
    console.warn(`[session:${port.name()}] the remote Claude token was refused; respawning once with a fresh token`);
    return port.forceRestart({ resumePrompt: AUTO_CONTINUE_PROMPT });
  }

  function buildEnv({ extraEnv = port.spawnEnv(), ...options }: {
    extraEnv?: Record<string, string> | null;
    prependPathDirs?: readonly string[];
  } = {}) {
    return adapter.buildEnv(process.env, extraEnv, options);
  }

  function noteTurnStopped(): void {
    hasRespawnedForAuth = false;
  }

  return {
    buildEnv,
    agentApiEnv,
    commitSigningEnv: signingEnv,
    spawnCwdSpellings,
    spawnCommandFor,
    startRemoteCodexBridge,
    stopCodexBridge,
    respawnAfterAuthFailure,
    noteTurnStopped,
  };
}

export { createSessionLaunch };
export type { RemoteLaunch, SessionLaunch };

import fs from 'node:fs';
import os from 'node:os';
import { projectDirCandidates } from '../server/core/claude-config-paths-core.ts';
import { resolveHostResourceProfile } from '../server/core/memory-admission-core.ts';
import { launchSecretNames } from '../shared/agent-models-core.ts';
import type { LaunchPlan } from '../shared/agent-models-core.ts';
import { canonicalizePath } from '../shared/canonical-paths.ts';
import { clock } from '../shared/clock.ts';
import type { PackMcpLaunch, PackMcpLaunchHold, PackMcpServer } from '../shared/contracts/pack.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { errorMessage } from '../shared/text.ts';
import { commandFor, hookProfileOf } from './adapters/index.ts';
import type { AgentAdapter } from './adapters/index.ts';
import { holdPreparedAgentHome, prepareAccountHome, prepareSandboxedAccountHome, realAgentHome, releaseAgentHome, sessionAgentHomePath } from './agent-home.ts';
import { CODEX_HOME_PROFILE, renderCodexHooksBlock } from './core/agent-home-core.ts';
import type { SessionAccountHome } from './core/agent-account-core.ts';
import { resolveResumeTarget } from './core/auto-resume.ts';
import { commitSigningSetting, gitConfigEnv } from './core/commit-signing-env.ts';
import type { GitConfigForm } from './core/commit-signing-env.ts';
import { gitCredentialSetting } from './core/git-credential-env.ts';
import { packHookFilesEnv } from './core/pack-hook-core.ts';
import type { PackAgentLaunch } from './core/pack-session-core.ts';
import type { ResolvedCommand } from './core/spawn-command.ts';
import type { GraphicalSessionState, SpawnEnv } from './core/spawn-env.ts';
import type { createSessionHookLifecycle } from './session-hook-lifecycle.ts';

interface SpawnCommand {
  file: string;
  args: string[];
}

type LaunchSecretsOutcome = { valuesByName: Record<string, string> } | { refusal: string };
type ResolveLaunchSecrets = (request: { names: string[]; cwd: string }) => Promise<LaunchSecretsOutcome | { held: Promise<LaunchSecretsOutcome> }>;

interface SandboxLaunchFacts {
  agent: string;
  accountFolder: string | null;
  file: string;
  args: string[];
  env: SpawnEnv;
  launchSetEnvNames: readonly string[];
  cwd: string;
}

interface SandboxLaunch {
  file: string;
  args: string[];
  env: SpawnEnv;
  dispose(): Promise<void>;
  awaitLoginProof?: () => Promise<string | null>;
}

type SandboxRefusalCode =
  | 'SANDBOX_ENDPOINT_NOT_LISTENING'
  | 'SANDBOX_TOOLS_MISSING'
  | 'SANDBOX_CREDENTIAL_PROXY_FAILED'
  | 'SANDBOX_SETTINGS_UNWRITABLE'
  | 'SANDBOX_BRIDGE_LISTEN_FAILED'
  | 'SANDBOX_LAUNCH_FAILED'
  | 'SANDBOX_PREPARE_FAILED'
  | 'SANDBOX_NO_TEMP_FOLDER'
  | 'SANDBOX_PLATFORM_UNSUPPORTED';

type SandboxRefusal = { ok: false; reason: string; code: SandboxRefusalCode };

type PrepareSandbox = (facts: SandboxLaunchFacts) => Promise<{ ok: true; launch: SandboxLaunch } | SandboxRefusal>;

type LaunchHooks = Pick<ReturnType<typeof createSessionHookLifecycle>, 'listenerPort'>;

interface LaunchPort {
  platform: () => NodeJS.Platform;
  effectiveCwd: () => string;
  spawnEnv: () => Record<string, string> | null;
  spawnCommand: () => ResolvedCommand | null;
  agentToken: () => string | null;
  commitSigningToken: () => string | null;
  commitSigningProgram: () => string | null;
  ensureGhShim?: (() => string | null) | null;
  gitCredentialToken: () => string | null;
  resolveGitCredentialHelper: ((cwd: string) => Promise<string | null>) | null;
  resolveHostSigningEnv: ((cwd: string) => Promise<Record<string, string>>) | null;
  resolveLaunchSecrets: ResolveLaunchSecrets | null;
  resolveAccountHome: (() => SessionAccountHome) | null;
  getPackAgentLaunch: () => PackAgentLaunch | null;
  getPackMcpServers: () => ((agentId: string, cwd: string) => Promise<PackMcpLaunchHold>) | null;
  getSharedPackMcpServers: () => ((agentId: string) => PackMcpServer[]) | null;
  prepareSandbox: PrepareSandbox | null;
  privateHomeKey: string | null;
  probeGraphicalSession: () => Promise<GraphicalSessionState>;
  onSandboxRefused: (cause: Error) => void;
  onSupersededSandbox: () => void;
}

interface SessionLaunchOptions {
  id: string;
  usageVendor: string;
  adapter: AgentAdapter;
  hooks: LaunchHooks;
  port: LaunchPort;
}

interface SessionLaunch {
  readonly accountIdInUse: string | null;
  readonly accountInUseSinceMs: number | null;
  readonly accountFolder: string | null;
  readonly accountId: string | null;
  readonly isSandboxed: boolean;
  readonly hasActiveSandbox: boolean;
  readonly packLaunch: PackAgentLaunch | null;
  readonly packMcpServers: readonly PackMcpServer[];
  readonly sharedPackMcpServers: readonly PackMcpServer[];
  readonly packMcpEnv: Readonly<Record<string, string>>;
  buildEnv(options?: { extraEnv?: Record<string, string> | null; prependPathDirs?: readonly string[] }): SpawnEnv;
  launchSpawnEnv(): Record<string, string> | null;
  agentApiEnv(): Record<string, string>;
  gitEnv(): Record<string, string>;
  spawnCwdSpellings(): string[];
  spawnCommandFor(input: { settingsArgs: string[]; agentArgs: string[] }): SpawnCommand;
  resolveGitAndSigning(cwd: string, isSuperseded: () => boolean): Promise<boolean>;
  resolveLaunchSecretEnv(plan: LaunchPlan, cwd: string): Promise<{ env: Record<string, string> } | { refusal: string } | { held: Promise<LaunchSecretsOutcome> }>;
  resolvePackMcpLaunch(cwd: string): Promise<PackMcpLaunchHold>;
  acceptApprovedLaunchSecrets(valuesByName: Record<string, string>): void;
  acceptApprovedPackMcpLaunch(launch: PackMcpLaunch): void;
  clearApprovedLaunches(): void;
  prepareAccountAndPacks(isCleanHome: boolean, packMcpLaunch: PackMcpLaunch, isSuperseded: () => boolean): Promise<string | null>;
  prepareAcpAgentHome(isCleanHome: boolean): string | null;
  releaseAcpAgentHome(): void;
  resolveResumeSessionId(configuredId: string | null, transcriptPath: string | null, env: SpawnEnv): { resumeSessionId: string | null; checkedTranscriptPaths: string[] };
  sandboxedCommand(command: SpawnCommand, env: SpawnEnv, launchSetEnvNames: readonly string[], isSuperseded: () => boolean): Promise<{ file: string; args: string[]; env: SpawnEnv } | null>;
  osSandboxArgs(dangerouslySkipPermissions: boolean): string[];
  shouldDetachDesktopBus(): Promise<boolean>;
  disposeSandbox(): void;
  sandboxLoginProof(): (() => Promise<string | null>) | null;
}

const liveAcpTrustedFoldersByHome = new Map<string, Map<string, number>>();

function holdAcpTrustedFolder(generatedHome: string, folder: string): string[] {
  const counts = liveAcpTrustedFoldersByHome.get(generatedHome) ?? new Map<string, number>();
  counts.set(folder, (counts.get(folder) ?? 0) + 1);
  liveAcpTrustedFoldersByHome.set(generatedHome, counts);
  return [...new Set([...counts.keys()].flatMap((liveFolder) => [liveFolder, canonicalizePath(liveFolder)]))];
}

function releaseAcpTrustedFolder(generatedHome: string, folder: string): void {
  const counts = liveAcpTrustedFoldersByHome.get(generatedHome);
  if (!counts) return;
  const remaining = (counts.get(folder) ?? 0) - 1;
  if (remaining > 0) {
    counts.set(folder, remaining);
    return;
  }
  counts.delete(folder);
  if (counts.size === 0) liveAcpTrustedFoldersByHome.delete(generatedHome);
}

function launchSecretEnvOf(plan: LaunchPlan, valuesByName: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(plan.secretEnv).map(([envName, secretName]) => [envName, valuesByName[secretName] ?? '']));
}

function createSessionLaunch({ id, usageVendor, adapter, hooks, port }: SessionLaunchOptions): SessionLaunch {
  let accountEnv: Record<string, string> = {};
  let accountFolder: string | null = null;
  let accountIdInUse: string | null = null;
  let accountInUseSinceMs: number | null = null;
  let packLaunch: PackAgentLaunch | null = null;
  let packMcpServers: readonly PackMcpServer[] = [];
  let sharedPackMcpServers: readonly PackMcpServer[] = [];
  let packMcpEnv: Readonly<Record<string, string>> = {};
  let approvedLaunchSecrets: Record<string, string> | null = null;
  let approvedPackMcpLaunch: PackMcpLaunch | null = null;
  let resolvedCommitSigningProgram: string | null = null;
  let hasResolvedCommitSigningProgram = false;
  let gitCredentialProgram: string | null = null;
  let hostSigningEnv: Record<string, string> = {};
  let sandboxLaunch: SandboxLaunch | null = null;
  let heldAcpHome: { home: string; folder: string } | null = null;

  function gitConfigForm(): GitConfigForm {
    return port.prepareSandbox === null ? 'parameters' : 'numbered';
  }

  function launchSpawnEnv(): Record<string, string> | null {
    const baseEnv = port.spawnEnv();
    const packHookEnv = packHookFilesEnv(packLaunch?.hookFiles ?? []);
    if (Object.keys(accountEnv).length === 0 && Object.keys(packHookEnv).length === 0) return baseEnv;
    return { ...(baseEnv || {}), ...packHookEnv, ...accountEnv };
  }

  function agentApiEnv(): Record<string, string> {
    const agentToken = port.agentToken();
    if (!agentToken) return {};
    const listenerPort = hooks.listenerPort();
    if (!listenerPort) return {};
    const url = `http://127.0.0.1:${listenerPort}/agent/${encodeURIComponent(id)}?t=${encodeURIComponent(agentToken)}`;
    return { [AGENT_URL_ENV]: url };
  }

  function gitEnv(): Record<string, string> {
    const inheritedEnv = launchSpawnEnv() ?? {};
    const form = gitConfigForm();
    const signing = commitSigningSetting({
      port: hooks.listenerPort(),
      sessionId: id,
      token: port.commitSigningToken(),
      signingProgram: hasResolvedCommitSigningProgram ? resolvedCommitSigningProgram : port.commitSigningProgram(),
    });
    const credential = gitCredentialSetting({
      port: hooks.listenerPort(),
      sessionId: id,
      token: port.gitCredentialToken(),
      helperProgram: gitCredentialProgram,
      form,
    });
    const configEnv = gitConfigEnv({
      configEntries: [...signing.configEntries, ...credential.configEntries],
      form,
      inheritedConfigParameters: inheritedEnv.GIT_CONFIG_PARAMETERS ?? process.env.GIT_CONFIG_PARAMETERS,
      inheritedConfigCount: inheritedEnv.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT,
    });
    const signingEnv = signing.configEntries.length > 0 ? hostSigningEnv : {};
    return { ...signingEnv, ...signing.env, ...credential.env, ...configEnv };
  }

  function spawnCwdSpellings(): string[] {
    const spawnCwd = port.effectiveCwd();
    try {
      return Array.from(new Set([spawnCwd, fs.realpathSync.native(spawnCwd)]));
    } catch {
      return [spawnCwd];
    }
  }

  function spawnCommandFor({ settingsArgs, agentArgs }: { settingsArgs: string[]; agentArgs: string[] }): SpawnCommand {
    const command = adapter.buildSpawnCommand({
      platform: port.platform(),
      resolved: port.spawnCommand() || commandFor(adapter),
      settingsArgs,
      agentArgs,
    });
    return { file: command.file, args: command.args };
  }

  function buildEnv({ extraEnv = launchSpawnEnv(), ...options }: {
    extraEnv?: Record<string, string> | null;
    prependPathDirs?: readonly string[];
  } = {}): SpawnEnv {
    return adapter.buildEnv(process.env, extraEnv, { ...options, resourceProfile: resolveHostResourceProfile(os.totalmem()) });
  }

  async function resolveGitAndSigning(cwd: string, isSuperseded: () => boolean): Promise<boolean> {
    resolvedCommitSigningProgram = port.commitSigningProgram();
    hasResolvedCommitSigningProgram = true;
    port.ensureGhShim?.();
    if (port.resolveGitCredentialHelper) {
      gitCredentialProgram = await port.resolveGitCredentialHelper(cwd);
      if (isSuperseded()) return false;
    }
    if (port.resolveHostSigningEnv) {
      hostSigningEnv = await port.resolveHostSigningEnv(cwd);
      if (isSuperseded()) return false;
    }
    return true;
  }

  async function resolveLaunchSecretEnv(plan: LaunchPlan, cwd: string): Promise<{ env: Record<string, string> } | { refusal: string } | { held: Promise<LaunchSecretsOutcome> }> {
    const names = launchSecretNames(plan);
    if (names.length === 0) return { env: {} };
    if (approvedLaunchSecrets !== null) return { env: launchSecretEnvOf(plan, approvedLaunchSecrets) };
    if (!port.resolveLaunchSecrets) return { refusal: `${names.join(', ')} cannot be read: no vault is wired to this session` };
    const resolved = await port.resolveLaunchSecrets({ names, cwd });
    if ('valuesByName' in resolved) return { env: launchSecretEnvOf(plan, resolved.valuesByName) };
    return resolved;
  }

  async function resolvePackMcpLaunch(cwd: string): Promise<PackMcpLaunchHold> {
    if (approvedPackMcpLaunch !== null) return approvedPackMcpLaunch;
    const packMcpServersProvider = port.getPackMcpServers();
    if (!packMcpServersProvider) return { servers: [], env: {} };
    return packMcpServersProvider(adapter.id, cwd);
  }

  function clearApprovedLaunches(): void {
    approvedLaunchSecrets = null;
    approvedPackMcpLaunch = null;
  }

  async function prepareSandboxedConfigHome(): Promise<string | null> {
    const profile = adapter.accountHomeProfile;
    if (port.prepareSandbox === null || hookProfileOf(adapter)?.injection.kind !== 'settings-file' || !profile) return null;
    const prepared = await prepareSandboxedAccountHome(profile, { env: process.env, accountFolder, privateKey: port.privateHomeKey });
    if ('refusal' in prepared) return `the sandboxed ${adapter.label} home cannot be prepared: ${prepared.refusal}`;
    accountEnv = { [profile.homeEnvName]: prepared.home };
    return null;
  }

  async function prepareAccountFolder(targetFolder: string): Promise<string | null> {
    const profile = adapter.accountHomeProfile;
    if (profile) {
      const prepared = await prepareAccountHome(profile, { env: process.env, accountFolder: targetFolder });
      return 'refusal' in prepared ? prepared.refusal : null;
    }
    const folderStat = await fs.promises.stat(targetFolder).catch(() => null);
    return folderStat?.isDirectory() ? null : `the account folder ${targetFolder} is missing`;
  }

  async function prepareAccountEnv(): Promise<string | null> {
    accountEnv = {};
    accountFolder = null;
    accountIdInUse = null;
    accountInUseSinceMs = clock.nowMs();
    const accountHome = port.resolveAccountHome?.() ?? { kind: 'machine-login' as const };
    if (accountHome.kind === 'machine-login') return prepareSandboxedConfigHome();
    if (accountHome.kind === 'refused') return accountHome.reason;
    const homeEnvName = adapter.accountHomeProfile?.homeEnvName ?? adapter.accountHomeEnvName;
    if (!homeEnvName) return `${adapter.label} sessions cannot run under an added account`;
    accountIdInUse = accountHome.account.id;
    const refusal = await prepareAccountFolder(accountHome.account.folder);
    if (refusal !== null) {
      accountIdInUse = null;
      return `the account ${accountHome.account.label} cannot be used: ${refusal}`;
    }
    accountFolder = accountHome.account.folder;
    accountEnv = { [homeEnvName]: accountHome.account.folder };
    const sandboxRefusal = await prepareSandboxedConfigHome();
    if (sandboxRefusal === null) return null;
    accountEnv = {};
    accountFolder = null;
    accountIdInUse = null;
    return sandboxRefusal;
  }

  async function prepareAccountAndPacks(isCleanHome: boolean, packMcpLaunch: PackMcpLaunch, isSuperseded: () => boolean): Promise<string | null> {
    packLaunch = !isCleanHome ? port.getPackAgentLaunch() : null;
    const accountRefusal = await prepareAccountEnv();
    if (isSuperseded()) return null;
    if (accountRefusal !== null) return accountRefusal;
    packMcpServers = packMcpLaunch.servers;
    packMcpEnv = packMcpLaunch.env;
    const sharedPackMcpServersProvider = port.getSharedPackMcpServers();
    sharedPackMcpServers = sharedPackMcpServersProvider ? sharedPackMcpServersProvider(adapter.id) : [];
    return null;
  }

  function releaseAcpAgentHome(): void {
    if (heldAcpHome === null) return;
    const { home, folder } = heldAcpHome;
    heldAcpHome = null;
    releaseAcpTrustedFolder(home, folder);
    releaseAgentHome(home);
  }

  function prepareAcpAgentHome(isCleanHome: boolean): string | null {
    releaseAcpAgentHome();
    if (adapter.id !== 'codex') return null;
    const isSandboxed = port.prepareSandbox !== null;
    const privateKey = isSandboxed ? port.privateHomeKey : null;
    const realHome = realAgentHome(CODEX_HOME_PROFILE, process.env);
    const generatedHome = sessionAgentHomePath(CODEX_HOME_PROFILE, process.env, {
      isClean: isCleanHome,
      accountFolder,
      isSandboxed,
      privateKey,
      homeVariant: 'acp',
    });
    const sessionFolder = port.effectiveCwd();
    const trustedFolders = holdAcpTrustedFolder(generatedHome, sessionFolder);
    const prepared = holdPreparedAgentHome(
      CODEX_HOME_PROFILE,
      process.env,
      (operatorText) => renderCodexHooksBlock({
        hooks: [],
        trustedHashes: null,
        projectHookTrust: [],
        operatorText,
        realHome,
        generatedHome: canonicalizePath(generatedHome),
        trustedFolders,
      }),
      {
        isClean: isCleanHome,
        accountFolder,
        packSkillDirs: packLaunch?.namedSkillDirs ?? [],
        isSandboxed,
        privateKey,
        homeVariant: 'acp',
      },
    );
    if ('refusal' in prepared) {
      releaseAcpTrustedFolder(generatedHome, sessionFolder);
      return `${adapter.label} cannot start over ACP: ${prepared.refusal}`;
    }
    heldAcpHome = { home: prepared.home, folder: sessionFolder };
    accountEnv = { ...accountEnv, [CODEX_HOME_PROFILE.homeEnvName]: prepared.home };
    return null;
  }

  function resolveResumeSessionId(configuredId: string | null, transcriptPath: string | null, env: SpawnEnv): { resumeSessionId: string | null; checkedTranscriptPaths: string[] } {
    if (usageVendor !== 'claude') return { resumeSessionId: configuredId, checkedTranscriptPaths: [] };
    return resolveResumeTarget({
      resumeSessionId: configuredId,
      transcriptPath,
      projectsDirs: projectDirCandidates(env, [], os.homedir()),
      cwds: spawnCwdSpellings(),
    }, { existsSync: fs.existsSync, readdirSync: fs.readdirSync });
  }

  function disposeLaunch(launch: SandboxLaunch): void {
    launch.dispose().catch((error: unknown) => console.warn(`[session ${id}] sandbox cleanup failed: ${errorMessage(error)}`));
  }

  function disposeSandbox(): void {
    const launch = sandboxLaunch;
    if (launch === null) return;
    sandboxLaunch = null;
    disposeLaunch(launch);
  }

  async function sandboxedCommand(command: SpawnCommand, env: SpawnEnv, launchSetEnvNames: readonly string[], isSuperseded: () => boolean): Promise<{ file: string; args: string[]; env: SpawnEnv } | null> {
    if (port.prepareSandbox === null) return { ...command, env };
    disposeSandbox();
    const prepared = await port.prepareSandbox({ ...command, agent: adapter.id, accountFolder, env, launchSetEnvNames, cwd: port.effectiveCwd() })
      .catch((error: unknown): SandboxRefusal => ({ ok: false, reason: errorMessage(error), code: 'SANDBOX_PREPARE_FAILED' }));
    if (isSuperseded()) {
      if (prepared.ok) disposeLaunch(prepared.launch);
      port.onSupersededSandbox();
      return null;
    }
    if (!prepared.ok) {
      port.onSandboxRefused(Object.assign(new Error(`the session sandbox refused to start: ${prepared.reason}`), { code: prepared.code }));
      return null;
    }
    sandboxLaunch = prepared.launch;
    return { file: prepared.launch.file, args: prepared.launch.args, env: prepared.launch.env };
  }

  function osSandboxArgs(dangerouslySkipPermissions: boolean): string[] {
    if (port.prepareSandbox === null) return [];
    return adapter.osSandboxArgs?.({ dangerouslySkipPermissions }) ?? [];
  }

  async function shouldDetachDesktopBus(): Promise<boolean> {
    if (port.platform() !== 'linux') return false;
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return false;
    return await port.probeGraphicalSession() === 'inactive';
  }

  return {
    get accountIdInUse() { return accountIdInUse; },
    get accountInUseSinceMs() { return accountInUseSinceMs; },
    get accountFolder() { return accountFolder; },
    get accountId() {
      const accountHome = port.resolveAccountHome?.() ?? null;
      return accountHome?.kind === 'account' ? accountHome.account.id : null;
    },
    get isSandboxed() { return port.prepareSandbox !== null; },
    get hasActiveSandbox() { return sandboxLaunch !== null; },
    get packLaunch() { return packLaunch; },
    get packMcpServers() { return packMcpServers; },
    get sharedPackMcpServers() { return sharedPackMcpServers; },
    get packMcpEnv() { return packMcpEnv; },
    buildEnv,
    launchSpawnEnv,
    agentApiEnv,
    gitEnv,
    spawnCwdSpellings,
    spawnCommandFor,
    resolveGitAndSigning,
    resolveLaunchSecretEnv,
    resolvePackMcpLaunch,
    acceptApprovedLaunchSecrets: (valuesByName) => { approvedLaunchSecrets = valuesByName; },
    acceptApprovedPackMcpLaunch: (launch) => { approvedPackMcpLaunch = launch; },
    clearApprovedLaunches,
    prepareAccountAndPacks,
    prepareAcpAgentHome,
    releaseAcpAgentHome,
    resolveResumeSessionId,
    sandboxedCommand,
    osSandboxArgs,
    shouldDetachDesktopBus,
    disposeSandbox,
    sandboxLoginProof: () => sandboxLaunch?.awaitLoginProof ?? null,
  };
}

export { createSessionLaunch };
export type { LaunchSecretsOutcome, PrepareSandbox, ResolveLaunchSecrets, SandboxLaunchFacts, SandboxRefusalCode, SessionLaunch };

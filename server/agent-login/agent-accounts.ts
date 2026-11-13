import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommandSafely } from '../child-process-safe.ts';
import { createAgentConnect } from './agent-connect.ts';
import { CONNECT_RECIPES, readAccountIdentity } from './core/agent-connect-core.ts';
import type { AccountIdentity } from './core/agent-connect-core.ts';
import { prepareAccountHome } from '../../session/agent-home.ts';
import { getAdapter } from '../../session/adapters/index.ts';
import { LANE_ACCOUNT_AGENT_ID, LaneAccountLane } from '../../shared/contracts/agent-accounts.ts';
import type { AgentAccount, AgentAccountLogin, AgentAccountStatus, LaneAccounts } from '../../shared/contracts/agent-accounts.ts';
import type { AgentLoginStatus, ConnectableAgent } from '../../shared/contracts/control-messages.ts';
import type { ConfigStore, GlimmervoidConfig } from '../config-store.ts';

const STATUS_TIMEOUT_MS = 20_000;
const STATUS_OUTPUT_LIMIT_BYTES = 256 * 1024;

interface CommandLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface PendingAccount {
  id: string;
  agent: ConnectableAgent;
  folder: string;
  connect: ReturnType<typeof createAgentConnect>;
  login: AgentAccountLogin;
  isExisting: boolean;
}

interface AgentAccountsOptions {
  accountsRoot: string;
  configStore: Pick<ConfigStore, 'config' | 'save'>;
  launchFor: (agent: ConnectableAgent, agentArgs: string[]) => CommandLaunch | null;
  liveSessionNamesUsing: (accountId: string) => string[];
  onConfigSaved: (config: GlimmervoidConfig) => void;
  onChange: (accounts: AgentAccountStatus[]) => void;
}

type AccountReply = { ok: true; accountId?: string } | { ok: false; error: string };

const ACCOUNT_AGENTS: readonly ConnectableAgent[] = Object.freeze(['claude-code', 'codex']);

function machineLoginLabel(identityLabel: string | null): string {
  return identityLabel === null ? 'This machine' : `This machine (${identityLabel})`;
}

function loginOf(state: AgentAccountLogin['state'], reason: string | null = null): AgentAccountLogin {
  return { state, verificationUrl: null, userCode: null, needsPastedCode: false, reason };
}

function accountLoginFrom(login: AgentLoginStatus): AgentAccountLogin {
  return { state: login.state, verificationUrl: login.verificationUrl, userCode: login.userCode, needsPastedCode: login.needsPastedCode, reason: login.reason };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function deleteFolder(folder: string): Promise<void> {
  return fs.rm(folder, { recursive: true, force: true }).catch(() => {});
}

function accountAgentOf(account: AgentAccount | undefined): ConnectableAgent | undefined {
  return ACCOUNT_AGENTS.find((candidate) => candidate === account?.agent);
}

function accountLaunch(agent: ConnectableAgent, launch: CommandLaunch, folder: string): CommandLaunch {
  const recipe = CONNECT_RECIPES[agent];
  const env = { ...launch.env, [recipe.homeEnvKey]: folder };
  for (const key of recipe.credentialEnvKeys) delete env[key];
  return { ...launch, env };
}

function withoutLanesOn(laneAccounts: LaneAccounts, accountId: string): LaneAccounts {
  return Object.fromEntries(Object.entries(laneAccounts).filter(([, laneAccountId]) => laneAccountId !== accountId));
}

async function isFolderPresent(folder: string): Promise<boolean> {
  return fs.stat(folder).then((stats) => stats.isDirectory(), () => false);
}

function createAgentAccounts({ accountsRoot, configStore, launchFor, liveSessionNamesUsing, onConfigSaved, onChange }: AgentAccountsOptions) {
  const identityByKey = new Map<string, AccountIdentity>();
  const pendingById = new Map<string, PendingAccount>();

  function configuredAccounts(): AgentAccount[] {
    return configStore.config.agentAccounts ?? [];
  }

  function identityKey(agent: string, accountId: string | null): string {
    return `${agent}\u0000${accountId ?? ''}`;
  }

  function defaultAccountIdOf(agent: ConnectableAgent): string | null {
    const defaultId = configStore.config.agentAccountDefaults?.[agent] ?? null;
    return configuredAccounts().some((account) => account.id === defaultId && account.agent === agent) ? defaultId : null;
  }

  function lanesPinnedTo(agent: string, accountId: string | null): LaneAccountLane[] {
    if (agent !== LANE_ACCOUNT_AGENT_ID) return [];
    const laneAccounts = configStore.config.laneAccounts ?? {};
    return LaneAccountLane.options.filter((lane) => laneAccounts[lane] === accountId);
  }

  function statusOf(agent: ConnectableAgent, account: AgentAccount | null): AgentAccountStatus {
    const lanes = lanesPinnedTo(agent, account?.id ?? null);
    const isDefault = defaultAccountIdOf(agent) === (account?.id ?? null);
    const identity = identityByKey.get(identityKey(agent, account?.id ?? null)) ?? null;
    const login = identity === null ? loginOf('signed-out', 'Checking the sign-in.') : loginOf(identity.isSignedIn ? 'signed-in' : 'signed-out');
    if (account === null) {
      return { accountId: null, agent, label: machineLoginLabel(identity?.label ?? null), detail: identity?.detail ?? null, login, usedBy: [], isPending: false, isDefault, lanes };
    }
    const pendingLogin = pendingById.get(account.id)?.login ?? null;
    return { accountId: account.id, agent, label: account.label, detail: identity?.detail ?? null, login: pendingLogin ?? login, usedBy: liveSessionNamesUsing(account.id), isPending: false, isDefault, lanes };
  }

  function uncheckedAgentStatuses(): AgentAccountStatus[] {
    const accounts = configuredAccounts().filter((account) => !ACCOUNT_AGENTS.some((agent) => agent === account.agent));
    const agents = [...new Set(accounts.map((account) => account.agent))];
    return agents.flatMap((agent) => {
      const defaultId = configStore.config.agentAccountDefaults?.[agent] ?? null;
      const agentAccounts = accounts.filter((account) => account.agent === agent);
      const isMachineDefault = !agentAccounts.some((account) => account.id === defaultId);
      const machineRow: AgentAccountStatus = { accountId: null, agent, label: machineLoginLabel(null), detail: null, login: loginOf('unchecked'), usedBy: [], isPending: false, isDefault: isMachineDefault, lanes: [] };
      return [machineRow, ...agentAccounts.map((account) => ({ accountId: account.id, agent, label: account.label, detail: null, login: loginOf('unchecked'), usedBy: liveSessionNamesUsing(account.id), isPending: false, isDefault: account.id === defaultId, lanes: [] }))];
    });
  }

  function list(): AgentAccountStatus[] {
    const statuses: AgentAccountStatus[] = [];
    for (const agent of ACCOUNT_AGENTS) {
      statuses.push(statusOf(agent, null));
      for (const account of configuredAccounts().filter((candidate) => candidate.agent === agent)) statuses.push(statusOf(agent, account));
      for (const pending of pendingById.values()) {
        if (pending.agent !== agent || pending.isExisting) continue;
        statuses.push({ accountId: pending.id, agent, label: `New ${CONNECT_RECIPES[agent].displayName} account`, detail: null, login: pending.login, usedBy: [], isPending: true, isDefault: false, lanes: [] });
      }
    }
    statuses.push(...uncheckedAgentStatuses());
    return statuses;
  }

  function announce(): void {
    onChange(list());
  }

  async function readIdentity(agent: ConnectableAgent, folder: string | null): Promise<AccountIdentity> {
    const recipe = CONNECT_RECIPES[agent];
    const launch = launchFor(agent, recipe.statusArgs);
    if (launch === null) return { isChecked: false, isSignedIn: false, label: null, detail: `The ${recipe.displayName} command could not be found on this machine.` };
    const statusLaunch = folder === null ? launch : accountLaunch(agent, launch, folder);
    const outcome = await runCommandSafely(statusLaunch.file, statusLaunch.args, { cwd: folder ?? accountsRoot, env: statusLaunch.env, timeoutMs: STATUS_TIMEOUT_MS, maxBufferBytes: STATUS_OUTPUT_LIMIT_BYTES });
    return readAccountIdentity(agent, outcome.stdout, outcome.exitCode);
  }

  async function refresh(): Promise<AgentAccountStatus[]> {
    await fs.mkdir(accountsRoot, { recursive: true, mode: 0o700 }).catch(() => {});
    const checks = ACCOUNT_AGENTS.flatMap((agent) => [
      { agent, accountId: null, folder: null },
      ...configuredAccounts().filter((account) => account.agent === agent).map((account) => ({ agent, accountId: account.id, folder: account.folder })),
    ]);
    await Promise.all(checks.map(async ({ agent, accountId, folder }) => {
      identityByKey.set(identityKey(agent, accountId), await readIdentity(agent, folder));
    }));
    announce();
    return list();
  }

  async function discardPending(pending: PendingAccount): Promise<void> {
    if (pendingById.get(pending.id) !== pending) return;
    pendingById.delete(pending.id);
    if (!pending.isExisting) await deleteFolder(pending.folder);
    announce();
  }

  async function abandonPending(pending: PendingAccount): Promise<void> {
    if (pendingById.get(pending.id) !== pending) return;
    pendingById.delete(pending.id);
    pending.connect.stop();
    if (!pending.isExisting) await deleteFolder(pending.folder);
    announce();
  }

  async function keepPending(pending: PendingAccount): Promise<void> {
    if (pendingById.get(pending.id) !== pending) return;
    const identity = await readIdentity(pending.agent, pending.folder);
    if (!identity.isSignedIn) {
      pending.login = loginOf('failed', `${CONNECT_RECIPES[pending.agent].displayName} finished signing in but the new account reads as signed out. Stop and add it again.`);
      announce();
      return;
    }
    if (pending.isExisting) {
      pendingById.delete(pending.id);
      if (!configuredAccounts().some((account) => account.id === pending.id)) {
        announce();
        return;
      }
      identityByKey.set(identityKey(pending.agent, pending.id), identity);
      announce();
      return;
    }
    const account: AgentAccount = { id: pending.id, agent: pending.agent, label: (identity.label ?? pending.id).slice(0, 60), folder: pending.folder };
    const freshConfig = configStore.save((config) => {
      config.agentAccounts = [...(config.agentAccounts ?? []), account];
    });
    if (!freshConfig) {
      pending.login = loginOf('failed', 'The new account signed in, but config.json could not be written. Stop and add it again.');
      announce();
      return;
    }
    pendingById.delete(pending.id);
    identityByKey.set(identityKey(pending.agent, pending.id), identity);
    onConfigSaved(freshConfig);
    announce();
  }

  function followPending(pending: PendingAccount, login: AgentLoginStatus | undefined): void {
    if (!login || pendingById.get(pending.id) !== pending) return;
    if (login.state === 'signed-in') {
      void keepPending(pending);
      return;
    }
    if (login.state === 'signed-out') {
      void discardPending(pending);
      return;
    }
    pending.login = accountLoginFrom(login);
    announce();
  }

  async function startPending(agent: ConnectableAgent, id: string, folder: string, isExisting: boolean): Promise<AccountReply> {
    const profile = getAdapter(agent)?.accountHomeProfile;
    if (!profile) return { ok: false, error: `${CONNECT_RECIPES[agent].displayName} cannot hold an added account yet.` };
    const prepared = await prepareAccountHome(profile, { env: process.env, accountFolder: folder });
    if ('refusal' in prepared) return { ok: false, error: `Could not set up ${folder}: ${prepared.refusal}` };
    const pendingRef: { current: PendingAccount | null } = { current: null };
    const connect = createAgentConnect({
      loginsRoot: accountsRoot,
      agents: [agent],
      homeDirOf: () => folder,
      makeHomeDir: async () => {},
      loginSource: async () => ((await readIdentity(agent, folder)).isSignedIn ? 'glimmervoid' : null),
      launchFor: (_agent, loginArgs) => {
        const launch = launchFor(agent, loginArgs);
        return launch === null ? null : accountLaunch(agent, launch, folder);
      },
      onChange: (logins) => { if (pendingRef.current) followPending(pendingRef.current, logins[0]); },
    });
    const pending: PendingAccount = { id, agent, folder, connect, login: loginOf('connecting'), isExisting };
    pendingRef.current = pending;
    pendingById.set(id, pending);
    const started = await connect.start(agent);
    if (!started.ok) {
      await discardPending(pending);
      return started;
    }
    announce();
    return { ok: true, accountId: id };
  }

  async function add(agent: ConnectableAgent): Promise<AccountReply> {
    const id = `${agent === 'claude-code' ? 'claude' : agent}-${crypto.randomBytes(3).toString('hex')}`;
    const folder = path.join(accountsRoot, id);
    try {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    } catch (error) {
      return { ok: false, error: `Could not create ${folder}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const started = await startPending(agent, id, folder, false);
    if (!started.ok) await deleteFolder(folder);
    return started;
  }

  async function signIn(accountId: string): Promise<AccountReply> {
    const pending = pendingById.get(accountId);
    if (pending?.login.state === 'connecting') return { ok: true, accountId };
    if (pending) await discardPending(pending);
    if (pending && !pending.isExisting) return { ok: false, error: 'That sign-in was stopped. Add the account again.' };
    const account = configuredAccounts().find((candidate) => candidate.id === accountId);
    const agent = accountAgentOf(account);
    if (!account || !agent) return { ok: false, error: 'That account is not in config.json.' };
    return startPending(agent, account.id, account.folder, true);
  }

  async function cancel(accountId: string): Promise<AccountReply> {
    const pending = pendingById.get(accountId);
    if (!pending) return { ok: true };
    if (pending.login.state === 'connecting') {
      pending.connect.cancel(pending.agent);
      return { ok: true };
    }
    await discardPending(pending);
    return { ok: true };
  }

  function submitCode(accountId: string, code: string): AccountReply {
    const pending = pendingById.get(accountId);
    if (!pending) return { ok: false, error: 'That account is not waiting for a code.' };
    return pending.connect.submitCode(pending.agent, code);
  }

  async function signOut(agent: ConnectableAgent, account: AgentAccount): Promise<string | null> {
    if (!(await isFolderPresent(account.folder))) return null;
    const recipe = CONNECT_RECIPES[agent];
    const launch = launchFor(agent, recipe.logoutArgs);
    if (launch === null) return `The ${recipe.displayName} command could not be found, so ${account.label} cannot be signed out.`;
    const logoutLaunch = accountLaunch(agent, launch, account.folder);
    const outcome = await runCommandSafely(logoutLaunch.file, logoutLaunch.args, { cwd: account.folder, env: logoutLaunch.env, timeoutMs: STATUS_TIMEOUT_MS, maxBufferBytes: STATUS_OUTPUT_LIMIT_BYTES });
    if (outcome.ok) return null;
    return `${recipe.displayName} could not sign ${account.label} out: ${outcome.stderr.trim() || `exit code ${outcome.exitCode}`}`;
  }

  function inUseRefusal(account: AgentAccount): string | null {
    const usedBy = liveSessionNamesUsing(account.id);
    if (usedBy.length === 0) return null;
    return `${account.label} is in use by ${usedBy.join(', ')}. Switch those sessions to another account or close them first.`;
  }

  async function remove(accountId: string): Promise<AccountReply> {
    const pending = pendingById.get(accountId);
    const account = configuredAccounts().find((candidate) => candidate.id === accountId);
    if (!account && pending) {
      await abandonPending(pending);
      return { ok: true };
    }
    if (!account) return { ok: false, error: 'That account is not in config.json.' };
    const firstRefusal = inUseRefusal(account);
    if (firstRefusal !== null) return { ok: false, error: firstRefusal };
    if (pending) await abandonPending(pending);
    const agent = accountAgentOf(account);
    const isOwnedFolder = isInside(accountsRoot, account.folder);
    const signOutRefusal = agent && isOwnedFolder ? await signOut(agent, account) : null;
    if (signOutRefusal !== null) return { ok: false, error: signOutRefusal };
    const lateRefusal = inUseRefusal(account);
    if (lateRefusal !== null) return { ok: false, error: lateRefusal };
    const freshConfig = configStore.save((config) => {
      config.agentAccounts = (config.agentAccounts ?? []).filter((candidate) => candidate.id !== accountId);
      if (config.agentAccounts.length === 0) delete config.agentAccounts;
      if (config.agentAccountDefaults?.[account.agent] === accountId) delete config.agentAccountDefaults[account.agent];
      if (config.agentAccountDefaults && Object.keys(config.agentAccountDefaults).length === 0) delete config.agentAccountDefaults;
      config.laneAccounts = withoutLanesOn(config.laneAccounts ?? {}, accountId);
      if (Object.keys(config.laneAccounts).length === 0) delete config.laneAccounts;
    });
    if (!freshConfig) return { ok: false, error: 'Could not write config.json' };
    if (isOwnedFolder) await deleteFolder(account.folder);
    identityByKey.delete(identityKey(account.agent, accountId));
    onConfigSaved(freshConfig);
    announce();
    return { ok: true };
  }

  function setDefault(agent: string, accountId: string | null): AccountReply {
    const accountAgent = ACCOUNT_AGENTS.find((candidate) => candidate === agent);
    if (!accountAgent) return { ok: false, error: `${agent} cannot hold an added account yet.` };
    const account = accountId === null ? null : configuredAccounts().find((candidate) => candidate.id === accountId && candidate.agent === agent);
    if (account === undefined) return { ok: false, error: 'That account is not in config.json.' };
    const freshConfig = configStore.save((config) => {
      const defaults = { ...(config.agentAccountDefaults ?? {}) };
      delete defaults[accountAgent];
      if (account !== null) defaults[accountAgent] = account.id;
      config.agentAccountDefaults = defaults;
      if (Object.keys(defaults).length === 0) delete config.agentAccountDefaults;
    });
    if (!freshConfig) return { ok: false, error: 'Could not write config.json' };
    onConfigSaved(freshConfig);
    announce();
    return { ok: true };
  }

  function setLaneAccount(lane: LaneAccountLane, choice: { followsDefault: true } | { followsDefault: false; accountId: string | null }): AccountReply {
    const account = choice.followsDefault || choice.accountId === null ? null : configuredAccounts().find((candidate) => candidate.id === choice.accountId && candidate.agent === LANE_ACCOUNT_AGENT_ID);
    if (account === undefined) return { ok: false, error: 'That account is not a Claude Code account in config.json.' };
    const freshConfig = configStore.save((config) => {
      const laneAccounts = { ...(config.laneAccounts ?? {}) };
      delete laneAccounts[lane];
      if (!choice.followsDefault) laneAccounts[lane] = account?.id ?? null;
      config.laneAccounts = laneAccounts;
      if (Object.keys(laneAccounts).length === 0) delete config.laneAccounts;
    });
    if (!freshConfig) return { ok: false, error: 'Could not write config.json' };
    onConfigSaved(freshConfig);
    announce();
    return { ok: true };
  }

  async function signInRefusal(agent: string, accountId: string | null): Promise<{ error: string; needsSignIn: boolean } | null> {
    const accountAgent = ACCOUNT_AGENTS.find((candidate) => candidate === agent);
    if (!accountAgent) return null;
    const account = accountId === null ? null : configuredAccounts().find((candidate) => candidate.id === accountId && candidate.agent === agent);
    if (account === undefined) return { error: 'That account is not in config.json.', needsSignIn: false };
    const identity = await readIdentity(accountAgent, account?.folder ?? null);
    const label = account?.label ?? identity.label ?? `This machine's ${CONNECT_RECIPES[accountAgent].displayName} login`;
    if (!identity.isChecked) return { error: `Could not check whether ${label} is signed in${identity.detail ? `: ${identity.detail}` : '.'} Try again.`, needsSignIn: false };
    identityByKey.set(identityKey(accountAgent, account?.id ?? null), identity);
    announce();
    if (identity.isSignedIn) return null;
    return { error: `${label} is signed out. Sign in to it in Settings > Accounts, then switch again.`, needsSignIn: true };
  }

  function stop(): void {
    for (const pending of pendingById.values()) pending.connect.stop();
  }

  return { add, cancel, list, refresh, remove, setDefault, setLaneAccount, signIn, signInRefusal, stop, submitCode };
}

type AgentAccounts = ReturnType<typeof createAgentAccounts>;

export { createAgentAccounts };
export type { AgentAccounts };

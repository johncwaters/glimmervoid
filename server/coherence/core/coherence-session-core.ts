import { z } from 'zod';
import type { CoherenceHooksState } from '../../../shared/contracts/session.ts';
import type { UserHook } from '../../../session/core/user-hooks-core.ts';
import type { SessionSpawnOverrides } from '../../session/session-factory.ts';

export const COHERENCE_HOOK_EVENTS = ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse'] as const;
export const COHERENCE_POST_TOOL_USE_MATCHER = 'Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit';

const claudeSessionIdSchema = z.uuid();

export type CoherenceSessionKind = 'factory' | 'writer' | 'review';
export type CoherenceHost = 'claude' | 'codex';

export function decideCoherenceAttachment({ sessionKind, isSettingOn }: { sessionKind: CoherenceSessionKind; isSettingOn: boolean }): boolean {
  return sessionKind === 'factory' || isSettingOn;
}

export const COHERENCE_NATIVE_CONTROL_FILES: Readonly<Record<CoherenceHost, readonly string[]>> = Object.freeze({
  claude: Object.freeze(['.claude/settings.json', '.claude/coherence-hook', '.claude/coherence-root']),
  codex: Object.freeze(['.codex/hooks.json', '.codex/coherence-hook', '.codex/coherence-root']),
});

export const COHERENCE_TARGET_SCRIPTS = Object.freeze({ 'coherence-hook': 'dist/hook-cli.js', coherence: 'dist/cli.js' });
export type CoherenceTargetBinName = keyof typeof COHERENCE_TARGET_SCRIPTS;
export const COHERENCE_TARGET_BIN_NAMES: readonly CoherenceTargetBinName[] = Object.freeze(['coherence-hook', 'coherence']);

export const COHERENCE_HOOKS_INACTIVE = Object.freeze({
  configMissing: 'config missing',
  controlFilesMissing: 'control files missing',
  nodeModulesNotIgnored: 'node_modules not ignored',
  sharedNodeModulesMissingCoherence: 'Coherence not installed in shared node_modules',
});

export function coherenceHooksStateFromCheck(exitCode: number | null): CoherenceHooksState {
  if (exitCode === 0) return { active: true };
  return { active: false, reason: exitCode === null ? 'check failed' : `check failed with exit code ${exitCode}` };
}

export function planCoherenceTargetShims(targets: readonly { binName: CoherenceTargetBinName; exists: boolean; isIgnored: boolean }[]):
  { ok: true; binNamesToWrite: CoherenceTargetBinName[] } | { ok: false; state: CoherenceHooksState } {
  const missingTargets = targets.filter((target) => !target.exists);
  if (missingTargets.some((target) => !target.isIgnored)) return { ok: false, state: { active: false, reason: COHERENCE_HOOKS_INACTIVE.nodeModulesNotIgnored } };
  return { ok: true, binNamesToWrite: missingTargets.map((target) => target.binName) };
}

function quoteCommandPath(commandPath: string): string {
  if (commandPath.includes('"')) throw new Error('Coherence command paths must not contain double quotes');
  return `"${commandPath}"`;
}

function shimPair(fileName: string, command: string) {
  return [
    { fileName, mode: 0o755, text: `#!/bin/sh\nexec ${command} "$@"\n` },
    { fileName: `${fileName}.cmd`, mode: 0o644, text: `@echo off\r\n${command} %*\r\n` },
  ];
}

const SHIM_UNSAFE_PATH_CHARACTERS = /["$`%\r\n]/;

export function buildCoherenceTargetShims({ nodePath, scriptPathByBinName, binNames, platform }: {
  nodePath: string; scriptPathByBinName: Readonly<Record<CoherenceTargetBinName, string>>; binNames: readonly CoherenceTargetBinName[]; platform: NodeJS.Platform;
}) {
  return binNames.flatMap((binName) => {
    const scriptPath = scriptPathByBinName[binName];
    if (SHIM_UNSAFE_PATH_CHARACTERS.test(nodePath) || SHIM_UNSAFE_PATH_CHARACTERS.test(scriptPath)) {
      throw new Error('Coherence shim paths must not contain quotes, dollar signs, backticks, percent signs or line breaks');
    }
    const shims = shimPair(binName, `${quoteCommandPath(nodePath)} ${quoteCommandPath(scriptPath)}`);
    return platform === 'win32' ? shims : shims.filter((shim) => !shim.fileName.endsWith('.cmd'));
  });
}

const COHERENCE_CLI_ON_PATH_HOOK: Readonly<UserHook> = Object.freeze({
  id: 'coherence-cli-on-path',
  name: 'Coherence CLI on PATH',
  event: 'SessionStart',
  type: 'command',
  enabled: true,
  command: 'echo In this Glimmervoid session coherence is on PATH, so run coherence followed by the verb wherever the Coherence instructions say npx coherence.',
});

export function buildCoherenceUserHooks({ nodePath, hookCliPath }: { nodePath: string; hookCliPath: string }): UserHook[] {
  const commandPrefix = `${quoteCommandPath(nodePath)} ${quoteCommandPath(hookCliPath)}`;
  return [...COHERENCE_HOOK_EVENTS.map<UserHook>((event) => ({
    id: `coherence-${event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    name: `Coherence ${event}`,
    event,
    type: 'command',
    enabled: true,
    command: `${commandPrefix} ${event}`,
    ...(event === 'PostToolUse' ? { matcher: COHERENCE_POST_TOOL_USE_MATCHER } : {}),
  })), { ...COHERENCE_CLI_ON_PATH_HOOK }];
}

function claudeSessionIdArgs(claudeSessionId: string): string[] {
  if (!claudeSessionIdSchema.safeParse(claudeSessionId).success) throw new Error('Coherence Claude session id must be a UUID');
  return ['--session-id', claudeSessionId];
}

export function buildCoherenceSessionOverrides({ claudeSessionId, shimDir }: { claudeSessionId: string; shimDir: string }) {
  return {
    extraClaudeArgs: claudeSessionIdArgs(claudeSessionId),
    extraUserHooks: [{ ...COHERENCE_CLI_ON_PATH_HOOK }],
    prependPathDirs: [shimDir],
  } satisfies SessionSpawnOverrides;
}

const COHERENCE_DECIDE_ALLOW_RULE = 'Bash(coherence decide:*)';

export function buildCoherenceJournalLaneOverrides({ claudeSessionId, nodePath, hookCliPath, shimDir, laneCwd, isResumed = false }: {
  claudeSessionId: string; nodePath: string; hookCliPath: string; shimDir: string; laneCwd: string; isResumed?: boolean;
}) {
  const sessionIdArgs = claudeSessionIdArgs(claudeSessionId);
  return {
    extraClaudeArgs: isResumed ? [] : sessionIdArgs,
    extraUserHooks: buildCoherenceUserHooks({ nodePath, hookCliPath }),
    prependPathDirs: [shimDir],
    spawnEnv: { COHERENCE_HOOK_HOST: 'claude', COHERENCE_PROJECT_ROOT: laneCwd },
    allowRules: [COHERENCE_DECIDE_ALLOW_RULE],
  };
}

const STORE_KEY_RESERVED_CHARACTERS = /[!'()*.~]/g;

export function coherenceJournalStoreKey({ source, identity }: { source: 'github' | 'project'; identity: string }): string {
  const comparableIdentity = source === 'github' ? identity.toLowerCase() : identity;
  const encodedIdentity = encodeURIComponent(comparableIdentity)
    .replace(STORE_KEY_RESERVED_CHARACTERS, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${source}-${encodedIdentity}`;
}

export function buildCoherenceShims({ nodePath, cliPath, glimmervoidCliPath }: { nodePath: string; cliPath: string; glimmervoidCliPath?: string }) {
  return [
    ...(glimmervoidCliPath ? shimPair('glimmervoid', `${quoteCommandPath(nodePath)} ${quoteCommandPath(glimmervoidCliPath)}`) : []),
    ...shimPair('coherence', `${quoteCommandPath(nodePath)} ${quoteCommandPath(cliPath)}`),
  ];
}

import path from 'node:path';
import { z } from 'zod';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import type { SessionSpawnOverrides } from '../session/session-factory.ts';

export const COHERENCE_HOOK_EVENTS = ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse'] as const;
export const COHERENCE_POST_TOOL_USE_MATCHER = 'Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit';
const CODEX_POST_TOOL_USE_MATCHER = 'Bash|apply_patch|update_plan|mcp__.*';
const CODEX_SESSION_START_MATCHER = 'startup|resume|clear|compact';

const claudeSessionIdSchema = z.uuid();

export type CoherenceSessionKind = 'factory' | 'writer' | 'review' | 'utility';

export function decideCoherenceAttachment({ sessionKind, isSettingOn, hasRepoConfig }: {
  sessionKind: CoherenceSessionKind; isSettingOn: boolean; hasRepoConfig: boolean;
}): boolean {
  if (sessionKind === 'utility') return false;
  if (sessionKind === 'factory') return true;
  return isSettingOn && hasRepoConfig;
}

function quoteCommandPath(commandPath: string): string {
  if (commandPath.includes('"')) throw new Error('Coherence command paths must not contain double quotes');
  return `"${commandPath}"`;
}

export function buildCoherenceUserHooks({ nodePath, hookCliPath, host = 'claude' }: {
  nodePath: string; hookCliPath: string; host?: 'claude' | 'codex';
}): UserHook[] {
  const commandPrefix = `${quoteCommandPath(nodePath)} ${quoteCommandPath(hookCliPath)}`;
  return [...COHERENCE_HOOK_EVENTS.map<UserHook>((event) => ({
    id: `coherence-${event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    name: `Coherence ${event}`,
    event,
    type: 'command',
    enabled: true,
    command: `${commandPrefix} ${event}`,
    ...(event === 'PostToolUse' ? { matcher: host === 'codex' ? CODEX_POST_TOOL_USE_MATCHER : COHERENCE_POST_TOOL_USE_MATCHER } : {}),
    ...(event === 'SessionStart' && host === 'codex' ? { matcher: CODEX_SESSION_START_MATCHER } : {}),
  })), {
    id: 'coherence-cli-on-path',
    name: 'Coherence CLI on PATH',
    event: 'SessionStart',
    type: 'command',
    enabled: true,
    command: 'echo In this Glimmervoid session coherence is on PATH, so run coherence followed by the verb wherever the Coherence instructions say npx coherence.',
  }];
}

const ECHO_UNSAFE_PATH_CHARACTERS = /["'`$;&|<>()\\\r\n%!*?[\]{}#~]/;

function withCodexShimNote(hook: UserHook, shimDir: string): UserHook {
  if (hook.id !== 'coherence-cli-on-path' || ECHO_UNSAFE_PATH_CHARACTERS.test(shimDir)) return hook;
  const shimCommand = path.join(shimDir, 'coherence');
  return { ...hook, command: `echo In this Glimmervoid session run ${shimCommand} followed by the verb wherever the Coherence instructions say npx coherence, because a login shell drops it from PATH.` };
}

export function buildCoherenceWriterOverrides({ nodePath, hookCliPath, shimDir, host = 'claude' }: {
  nodePath: string; hookCliPath: string; shimDir: string; host?: 'claude' | 'codex';
}) {
  const hooks = buildCoherenceUserHooks({ nodePath, hookCliPath, host });
  return {
    extraUserHooks: host === 'codex' ? hooks.map((hook) => withCodexShimNote(hook, shimDir)) : hooks,
    prependPathDirs: [shimDir],
    spawnEnv: { COHERENCE_HOOK_HOST: host },
  } satisfies SessionSpawnOverrides;
}

export function buildCoherenceSessionOverrides({ claudeSessionId, nodePath, hookCliPath, shimDir }: {
  claudeSessionId: string; nodePath: string; hookCliPath: string; shimDir: string;
}) {
  if (!claudeSessionIdSchema.safeParse(claudeSessionId).success) throw new Error('Coherence Claude session id must be a UUID');
  return {
    extraClaudeArgs: ['--session-id', claudeSessionId],
    extraUserHooks: buildCoherenceUserHooks({ nodePath, hookCliPath }),
    prependPathDirs: [shimDir],
    spawnEnv: { COHERENCE_HOOK_HOST: 'claude' },
  } satisfies SessionSpawnOverrides;
}

export function buildCoherenceShims({ nodePath, cliPath, glimmervoidCliPath }: { nodePath: string; cliPath: string; glimmervoidCliPath?: string }) {
  const commandPrefix = `${quoteCommandPath(nodePath)} ${quoteCommandPath(cliPath)}`;
  const glimmervoidCommand = glimmervoidCliPath ? `${quoteCommandPath(nodePath)} ${quoteCommandPath(glimmervoidCliPath)}` : null;
  return [
    ...(glimmervoidCommand ? [
      { fileName: 'glimmervoid', mode: 0o755, text: `#!/bin/sh\nexec ${glimmervoidCommand} "$@"\n` },
      { fileName: 'glimmervoid.cmd', mode: 0o644, text: `@echo off\r\n${glimmervoidCommand} %*\r\n` },
    ] : []),
    { fileName: 'coherence', mode: 0o755, text: `#!/bin/sh\nexec ${commandPrefix} "$@"\n` },
    { fileName: 'coherence.cmd', mode: 0o644, text: `@echo off\r\n${commandPrefix} %*\r\n` },
  ];
}

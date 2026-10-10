import { z } from 'zod';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import type { SessionSpawnOverrides } from '../session-factory.ts';

export const COHERENCE_HOOK_EVENTS = ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse'] as const;
export const COHERENCE_POST_TOOL_USE_MATCHER = 'Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit';

const claudeSessionIdSchema = z.uuid();

function quoteCommandPath(commandPath: string): string {
  if (commandPath.includes('"')) throw new Error('Coherence command paths must not contain double quotes');
  return `"${commandPath}"`;
}

export function buildCoherenceUserHooks({ nodePath, hookCliPath }: {
  nodePath: string; hookCliPath: string;
}): UserHook[] {
  const commandPrefix = `${quoteCommandPath(nodePath)} ${quoteCommandPath(hookCliPath)}`;
  return COHERENCE_HOOK_EVENTS.map((event) => ({
    id: `coherence-${event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    name: `Coherence ${event}`,
    event,
    type: 'command',
    enabled: true,
    command: `${commandPrefix} ${event}`,
    ...(event === 'PostToolUse' ? { matcher: COHERENCE_POST_TOOL_USE_MATCHER } : {}),
  }));
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

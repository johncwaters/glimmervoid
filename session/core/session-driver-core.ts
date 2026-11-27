import type { ParentLink, SessionDriverKind } from '../../shared/contracts/session.ts';
import { branchParentIdOf } from '../../shared/parent-link.ts';
import type { SessionDriverChoice } from '../drivers/driver.ts';
import { buildAcpAgentTable } from './acp-agents-core.ts';
import type { AcpAgentEntry } from './acp-agents-core.ts';
import type { z } from 'zod';

type PersistedSessionDriver = z.infer<typeof SessionDriverKind>;

interface StudioProjectCandidate {
  ephemeral?: boolean;
  isStudioMain?: boolean;
  parent?: ParentLink | null;
}

interface SessionDriverInput {
  isStudio: boolean;
  agentId: string;
  acpAgents?: unknown;
  persistedDriver?: PersistedSessionDriver;
  hasResumeSessionId?: boolean;
  mode: 'spawn' | 'load';
  clientVersion?: string;
}

type SessionDriverDecision =
  | { ok: true; driver: SessionDriverChoice; persistedDriver?: PersistedSessionDriver }
  | { ok: false; error: string };

const PTY_DRIVER: SessionDriverChoice = Object.freeze({ kind: 'pty' });

function isStudioProject(project: StudioProjectCandidate): boolean {
  return project.ephemeral !== true && (project.isStudioMain === true || branchParentIdOf(project.parent) !== null);
}

function formatUsableAcpAgents(entries: readonly AcpAgentEntry[]): string {
  return entries.map((entry) => `${entry.label} (${entry.id})`).join(', ');
}

function decideSessionDriver(input: SessionDriverInput): SessionDriverDecision {
  if (!input.isStudio) return { ok: true, driver: PTY_DRIVER };
  if (input.mode === 'load') {
    if (input.persistedDriver === 'pty') return { ok: true, driver: PTY_DRIVER };
    if (input.persistedDriver === undefined && input.hasResumeSessionId === true) return { ok: true, driver: PTY_DRIVER };
  }
  const table = buildAcpAgentTable(input.acpAgents ?? []);
  if (!table.ok) {
    if (input.mode === 'load' && input.persistedDriver === undefined) return { ok: true, driver: PTY_DRIVER };
    return { ok: false, error: table.error };
  }
  const entry = table.entriesById.get(input.agentId);
  if (!entry) {
    if (input.mode === 'load' && input.persistedDriver === undefined) return { ok: true, driver: PTY_DRIVER };
    return {
      ok: false,
      error: `Studio runs agents over ACP, and "${input.agentId}" has no ACP row. Usable ACP agents: ${formatUsableAcpAgents(table.entries)}.`,
    };
  }
  return {
    ok: true,
    driver: {
      kind: 'acp',
      command: { file: entry.command, args: [...entry.args] },
      mcpServers: [],
      clientVersion: input.clientVersion ?? '',
    },
    persistedDriver: 'acp',
  };
}

export {
  decideSessionDriver,
  isStudioProject,
};

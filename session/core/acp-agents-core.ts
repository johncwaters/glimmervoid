import path from 'node:path';
import {
  AcpAgentDeclarations,
  BUILTIN_ACP_AGENT_IDS,
  configIssueMessage,
} from '../../shared/contracts/config.ts';

const CLAUDE_ACP_PACKAGE_VERSION = '0.112.0';
const CODEX_ACP_PACKAGE_VERSION = '2.12.0';

interface AcpAgentEntry {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly isBuiltIn: boolean;
}

type AcpAgentTableResult =
  | { ok: true; entries: readonly AcpAgentEntry[]; entriesById: ReadonlyMap<string, AcpAgentEntry> }
  | { ok: false; error: string };

type AcpAgentLaunchResult =
  | { ok: true; entry: AcpAgentEntry; file: string; args: string[] }
  | { ok: false; error: string };

const BUILT_IN_ACP_AGENTS: readonly AcpAgentEntry[] = Object.freeze([
  Object.freeze({
    id: BUILTIN_ACP_AGENT_IDS[0],
    label: 'Claude Code',
    command: 'npx',
    args: Object.freeze(['-y', `@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_PACKAGE_VERSION}`]),
    isBuiltIn: true,
  }),
  Object.freeze({
    id: BUILTIN_ACP_AGENT_IDS[1],
    label: 'Codex CLI',
    command: 'npx',
    args: Object.freeze(['-y', `@agentclientprotocol/codex-acp@${CODEX_ACP_PACKAGE_VERSION}`]),
    isBuiltIn: true,
  }),
  Object.freeze({
    id: BUILTIN_ACP_AGENT_IDS[2],
    label: 'Antigravity',
    command: 'agy',
    args: Object.freeze(['acp']),
    isBuiltIn: true,
  }),
]);

function buildAcpAgentTable(extraRows: unknown = []): AcpAgentTableResult {
  const parsed = AcpAgentDeclarations.safeParse(extraRows);
  if (!parsed.success) return { ok: false, error: configIssueMessage(parsed.error) };
  const entries: AcpAgentEntry[] = [
    ...BUILT_IN_ACP_AGENTS,
    ...parsed.data.map((declaration) => Object.freeze({
      id: declaration.id,
      label: declaration.label,
      command: declaration.command,
      args: Object.freeze([...declaration.args]),
      isBuiltIn: false,
    })),
  ];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  return { ok: true, entries: Object.freeze(entries), entriesById };
}

function resolveAcpAgentLaunch(agentId: string, extraRows: unknown = []): AcpAgentLaunchResult {
  const table = buildAcpAgentTable(extraRows);
  if (!table.ok) return table;
  const entry = table.entriesById.get(agentId);
  if (!entry) return { ok: false, error: `unknown ACP agent "${agentId}"` };
  return { ok: true, entry, file: entry.command, args: [...entry.args] };
}

function isNpxCommand(command: string): boolean {
  const baseName = path.posix.basename(command.replaceAll('\\', '/')).toLowerCase();
  return baseName === 'npx' || baseName === 'npx.cmd' || baseName === 'npx.exe';
}

function npxPackageArgOf(args: readonly string[]): string | null {
  return args.find((argument) => argument.length > 0 && !argument.startsWith('-')) ?? null;
}

function formatAcpAgentDoctorValue(entry: AcpAgentEntry, resolvedPath: string | null): string {
  if (isNpxCommand(entry.command)) {
    if (resolvedPath === null) return 'not found on PATH (npx is required)';
    const packageSpec = npxPackageArgOf(entry.args);
    if (packageSpec) return `${resolvedPath} (via npx; ${packageSpec} not downloaded)`;
    return `${resolvedPath} (via npx; package not downloaded)`;
  }
  if (resolvedPath === null) return 'not found on PATH';
  return resolvedPath;
}

export {
  BUILT_IN_ACP_AGENTS,
  buildAcpAgentTable,
  formatAcpAgentDoctorValue,
  resolveAcpAgentLaunch,
};
export type { AcpAgentEntry, AcpAgentLaunchResult, AcpAgentTableResult };

import path from 'node:path';
import { buildGuardrailsLaunchPlan, guardrailsPolicyProbePaths } from '../../server/guardrails/core/guardrails-policy-core.ts';
import type { GuardrailsHost, GuardrailsLaunchPlan, GuardrailsRole } from '../../server/guardrails/core/guardrails-policy-core.ts';

const homeDir = path.resolve('/home/operator');
const glimmervoidHome = path.join(homeDir, '.glimmervoid');
const tempDir = path.join(glimmervoidHome, 'guardrails-temp', 'session-one');
const launchHomeDir = path.join(glimmervoidHome, 'guardrails-homes', 'session-one');
const agentSessionId = 'agent-session-one';
const worktree = path.resolve('/work/worktree');
const commonGitDir = path.resolve('/work/repo/.git');
const hostPaths = {
  homeDir,
  glimmervoidHome,
  glimmervoidConfigFile: path.join(glimmervoidHome, 'config.json'),
  tempDir,
  launchHomeDir,
  homeEntryNames: ['.claude', '.claude.json', '.claude.json.backup', '.codex', '.codex.old', '.kimi-code', 'Projects'],
  glimmervoidHomeEntryNames: ['agent-homes', 'config.json', 'guardrails-policies', 'guardrails-temp', 'scratch'],
  writeBlockedPaths: [] as string[],
  vendorLocations: {
    claude: { stateFolder: path.join(homeDir, '.claude'), configFiles: [path.join(homeDir, '.claude.json')], otherHomes: [path.join(homeDir, '.config', 'claude')], generatedHomes: [] },
    codex: { stateFolder: path.join(homeDir, '.codex'), configFiles: [], otherHomes: [], generatedHomes: [] },
    kimi: { stateFolder: path.join(homeDir, '.kimi-code'), configFiles: [], otherHomes: [], generatedHomes: [path.join(homeDir, '.glimmervoid', 'agent-homes', 'kimi')] },
  },
  unwrappedVendorHomes: [path.join(homeDir, '.grok')],
  relocatedXdgConfigHome: null,
};


function roleWith(overrides: Partial<GuardrailsRole> = {}): GuardrailsRole {
  return {
    vendors: ['claude'], vendorHome: { scope: 'launch', cwd: worktree, agentSessionId }, network: { access: 'allowlist', domains: [], hookPort: 4199 },
    writableRoots: [], lockedCheckouts: [], commitCheckouts: [], readDenied: [], readableWithinDenied: [], ...overrides,
  };
}

function hostWhereEveryProbedPathExists(role: GuardrailsRole): GuardrailsHost {
  return { ...hostPaths, existingPaths: new Set(guardrailsPolicyProbePaths(role, hostPaths)) };
}

function planFor(role: GuardrailsRole, host: GuardrailsHost = hostWhereEveryProbedPathExists(role)): GuardrailsLaunchPlan {
  const built = buildGuardrailsLaunchPlan(role, host);
  if (!built.ok) throw new Error(built.reason);
  return built.plan;
}

function entryPaths(entries: readonly (string | { path: string })[] | undefined): string[] {
  return (entries ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.path));
}

export { homeDir, glimmervoidHome, tempDir, launchHomeDir, agentSessionId, worktree, commonGitDir, hostPaths, roleWith, hostWhereEveryProbedPathExists, planFor, entryPaths };

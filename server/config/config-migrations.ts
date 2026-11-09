import path from 'node:path';
import { BranchGcFileSettings, configIssueMessage } from '../../shared/contracts/index.ts';
import { isRecord } from '../../shared/coerce.ts';
import type { GlimmervoidConfig } from './config-types.ts';
import { DEFAULT_CONFIG } from './config-defaults.ts';
import type { DefaultConfig } from './config-defaults.ts';

type BranchGcBlock = DefaultConfig['branchGc'];

function collectBranchGcIssues(branchGc: unknown): { block: BranchGcBlock; issues: string[] } {
  if (!isRecord(branchGc)) return { block: { ...DEFAULT_CONFIG.branchGc }, issues: [] };
  const accepted: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const [field, value] of Object.entries(branchGc)) {
    if (!Object.hasOwn(BranchGcFileSettings.shape, field)) {
      issues.push(`[config] Ignoring unknown branchGc.${field}; it is not a branchGc setting, so the default block applies.`);
      continue;
    }
    const parsed = BranchGcFileSettings.safeParse({ [field]: value });
    if (!parsed.success) {
      issues.push(`[config] Ignoring invalid branchGc.${field}; using the default instead: ${configIssueMessage(parsed.error)}`);
      continue;
    }
    accepted[field] = value;
  }
  return { block: { ...DEFAULT_CONFIG.branchGc, ...accepted }, issues };
}

function resolveBranchGc(branchGc: unknown): BranchGcBlock {
  return collectBranchGcIssues(branchGc).block;
}

function resolveBranchGcAndWarn(branchGc: unknown): BranchGcBlock {
  const resolved = collectBranchGcIssues(branchGc);
  for (const issue of resolved.issues) console.warn(issue);
  return resolved.block;
}

const RETIRED_PROJECT_FLAGS = Object.freeze(['unconfined', 'unguarded']);

function retiredGuardrailKeysWarning(config: GlimmervoidConfig): string | null {
  const projects: unknown[] = Array.isArray(config.projects) ? config.projects : [];
  const guardrails = config.guardrails;
  const retiredKeys = [
    ...(Object.hasOwn(config, 'sandbox') ? ['sandbox'] : []),
    ...(isRecord(guardrails) ? Object.keys(guardrails).filter((key) => key !== 'unreadablePaths').map((key) => `guardrails.${key}`) : []),
    ...RETIRED_PROJECT_FLAGS.filter((key) => projects.some((project) => isRecord(project) && Object.hasOwn(project, key))).map((key) => `projects[].${key}`),
  ];
  if (retiredKeys.length === 0) return null;
  return `[sane-yolo] config.json still has ${retiredKeys.join(', ')}; these keys are ignored (unreadablePaths moved to saneYoloUnreadablePaths)`;
}

function isAbsoluteOrHomePath(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false;
  const trimmedEntry = entry.trim();
  return trimmedEntry === '~' || trimmedEntry.startsWith('~/') || path.isAbsolute(trimmedEntry);
}

function migrateGuardrailsUnreadablePaths(config: GlimmervoidConfig): string | null {
  const guardrails = config.guardrails;
  if (!isRecord(guardrails) || !Object.hasOwn(guardrails, 'unreadablePaths')) return null;
  const { unreadablePaths: legacyUnreadablePaths, ...remainingGuardrails } = guardrails;
  config.guardrails = remainingGuardrails;
  if (config.saneYoloUnreadablePaths !== undefined) return '[config] Dropped guardrails.unreadablePaths: saneYoloUnreadablePaths is already set and takes its place.';
  const legacyEntries: unknown[] = Array.isArray(legacyUnreadablePaths) ? legacyUnreadablePaths : [];
  config.saneYoloUnreadablePaths = legacyEntries.filter(isAbsoluteOrHomePath);
  return '[config] Moved guardrails.unreadablePaths to saneYoloUnreadablePaths: Sane YOLO now refuses reads of those folders.';
}

function dropRetiredUpdateChannel(config: GlimmervoidConfig): string | null {
  if (!Object.hasOwn(config, 'updateChannel')) return null;
  delete config.updateChannel;
  return '[config] Removed updateChannel: Glimmervoid now updates only to published releases.';
}

function migrateRemoteEnabled(config: GlimmervoidConfig): string | null {
  const remote = config.remote;
  if (!isRecord(remote) || !Object.hasOwn(remote, 'enabled')) return null;
  const { enabled: _retiredEnabled, ...remainingRemote } = remote;
  config.remote = remainingRemote;
  return '[config] Dropped remote.enabled: the remote listener is always on, behind pairing.';
}

export { dropRetiredUpdateChannel, resolveBranchGc, resolveBranchGcAndWarn, retiredGuardrailKeysWarning, migrateGuardrailsUnreadablePaths, migrateRemoteEnabled };

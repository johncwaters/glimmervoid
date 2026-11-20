import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CODEMAP_ALLOW_REASON_MAX_CHARS, CODEMAP_EXPORT_KINDS } from '../../shared/contracts/codemap.ts';
import type { CodemapExportKind, CodemapSetup } from '../../shared/contracts/codemap.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { loadConfigFile } from '../config-store.ts';
import type { LoadedConfig } from '../config/config-file.ts';
import { decideConfigPath, glimmervoidHomeDir } from '../core/config-path-core.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import { buildCodemapModel, seededSetupOf } from '../core/codemap-graph-core.ts';
import { createCodemapClient } from './codemap-client.ts';
import { guessedDefaultBranchOf, mainlineShaOf, readCodemapSetup, repoKeyOf, setupPathOf, updateCodemapSetup, worktreeRootOf } from './codemap-store.ts';
import { checkWorktree, shrinkSetup } from './codemap-wiring.ts';

const OPERATOR_CODEMAP_ACTIONS = new Set(['setup', 'allow', 'shrink', 'check']);
const USAGE = 'usage: glimmervoid codemap setup <repo> [--gate on|off] [--exports lint,map|none] | codemap allow <repo> <from module> <to module> --reason <why> | codemap shrink <repo> | codemap check [--home <glimmervoid home>] [--config <config.json>]';

type CliOutcome = { ok: true; text: string; exitCode?: number } | { ok: false; error: string };

function optionValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function positionalsOf(args: readonly string[]): string[] {
  return args.filter((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
}

function configPathOrError(configArgument: string | null = null): { ok: true; configPath: string } | { ok: false; error: string } {
  if (configArgument) return fs.existsSync(configArgument) ? { ok: true, configPath: configArgument } : { ok: false, error: `no config.json at ${configArgument}` };
  const decided = decideConfigPath({ env: process.env, homeDir: glimmervoidHomeDir(os.homedir(), process.env) }, (candidate) => fs.existsSync(candidate));
  if (!decided.path) return { ok: false, error: `no config.json at ${decided.envPath ?? decided.homePath}; start Glimmervoid once to create it` };
  return { ok: true, configPath: decided.path };
}

function loadedConfigOf(configPath: string | null): LoadedConfig['config'] | null {
  const loaded = configPath ? loadConfigFile(configPath, { exitOnError: false }) : null;
  return loaded && 'config' in loaded ? loaded.config ?? null : null;
}

async function mainlineShaForCli(repoDir: string, configPath: string | null): Promise<string | null> {
  const config = loadedConfigOf(configPath);
  const configured = config ? configuredIntegrationBranch(config) : null;
  return mainlineShaOf(repoDir, configured ?? await guessedDefaultBranchOf(repoDir));
}

async function seededSetup(repoKey: string, mainlineSha: string): Promise<CodemapSetup> {
  return seededSetupOf(repoKey, buildCodemapModel(await createCodemapClient().extract(repoKey, mainlineSha)));
}

function exportKindsOf(exportsArgument: string): CodemapExportKind[] | null {
  if (exportsArgument === 'none') return [];
  const requested = exportsArgument.split(',').map((kind) => kind.trim());
  const exportKinds = CODEMAP_EXPORT_KINDS.filter((kind) => requested.includes(kind));
  return exportKinds.length === requested.length ? exportKinds : null;
}

async function runSetup(args: readonly string[]): Promise<CliOutcome> {
  const [, repoArgument] = positionalsOf(args);
  const gateArgument = optionValue(args, '--gate');
  const exportsArgument = optionValue(args, '--exports');
  const exportKinds = exportsArgument === null ? null : exportKindsOf(exportsArgument);
  if (!repoArgument || (gateArgument !== null && gateArgument !== 'on' && gateArgument !== 'off') || (exportsArgument !== null && exportKinds === null)) return { ok: false, error: USAGE };
  const repoKey = await repoKeyOf(path.resolve(repoArgument));
  if (!repoKey) return { ok: false, error: `${repoArgument} is not inside a git repository` };
  const homeDir = glimmervoidHomeDir(os.homedir(), process.env);
  const config = configPathOrError();
  const existing = await readCodemapSetup(homeDir, repoKey);
  if (existing.kind === 'invalid') return { ok: false, error: existing.message };
  const mainlineSha = await mainlineShaForCli(repoKey, config.ok ? config.configPath : null);
  if (!mainlineSha) return { ok: false, error: `${repoKey} has no mainline commit to seed the setup from` };
  const seeded = existing.kind === 'ok' ? null : await seededSetup(repoKey, mainlineSha);
  const isGateOn = (base: CodemapSetup) => (gateArgument === null ? base.gate : gateArgument === 'on');
  const updated = updateCodemapSetup(homeDir, repoKey, (current) => {
    const base = current ?? seeded;
    return base ? { ...base, gate: isGateOn(base), exports: exportKinds ?? base.exports } : null;
  });
  if (updated.kind !== 'ok') return { ok: false, error: updated.kind === 'invalid' ? updated.message : `${repoKey} has no code map setup to gate` };
  const { setup } = updated;
  return { ok: true, text: `code map setup for ${repoKey} at ${setupPathOf(homeDir, repoKey)}: ${setup.modules.length} modules, ${setup.allow.length} allowed module imports, import gate ${setup.gate ? 'on' : 'off'}, exports ${setup.exports.length > 0 ? setup.exports.join(', ') : 'none'}. The repo itself is unchanged.` };
}

async function runAllow(args: readonly string[]): Promise<CliOutcome> {
  const [, repoArgument, from, to] = positionalsOf(args);
  const reason = optionValue(args, '--reason')?.trim() ?? '';
  if (!repoArgument || !from || !to || !reason) return { ok: false, error: USAGE };
  if (reason.length > CODEMAP_ALLOW_REASON_MAX_CHARS) return { ok: false, error: `the reason must be at most ${CODEMAP_ALLOW_REASON_MAX_CHARS} characters` };
  const repoKey = await repoKeyOf(path.resolve(repoArgument));
  if (!repoKey) return { ok: false, error: `${repoArgument} is not inside a git repository` };
  const homeDir = glimmervoidHomeDir(os.homedir(), process.env);
  const allowedEntry = { from, to, origin: 'allowed' as const, reason, date: clock.dayKeyOf(clock.nowMs()), landed: false, fileImportCeiling: null };
  const allowOutcome = { wasAllowed: false };
  const updated = updateCodemapSetup(homeDir, repoKey, (current) => {
    allowOutcome.wasAllowed = current?.allow.some((edge) => edge.from === from && edge.to === to) ?? false;
    return current && !allowOutcome.wasAllowed ? { ...current, allow: [...current.allow, allowedEntry] } : null;
  });
  if (updated.kind === 'none') return { ok: false, error: `${repoKey} has no code map setup; run glimmervoid codemap setup ${repoKey} first` };
  if (updated.kind === 'invalid') return { ok: false, error: updated.message };
  const isAllowed = allowOutcome.wasAllowed;
  return { ok: true, text: `${from} -> ${to} is allowed for ${repoKey}${isAllowed ? ' already' : ''} (${setupPathOf(homeDir, repoKey)}).` };
}

async function runShrink(args: readonly string[]): Promise<CliOutcome> {
  const [, repoArgument] = positionalsOf(args);
  if (!repoArgument) return { ok: false, error: USAGE };
  const repoKey = await repoKeyOf(path.resolve(repoArgument));
  if (!repoKey) return { ok: false, error: `${repoArgument} is not inside a git repository` };
  const config = configPathOrError();
  const mainlineSha = await mainlineShaForCli(repoKey, config.ok ? config.configPath : null);
  if (!mainlineSha) return { ok: false, error: `${repoKey} has no mainline commit to shrink the setup against` };
  const shrunk = await shrinkSetup({ client: createCodemapClient(), homeDir: glimmervoidHomeDir(os.homedir(), process.env), repoKey, mainlineSha });
  return shrunk.ok ? { ok: true, text: shrunk.text } : shrunk;
}

async function runCheck(args: readonly string[]): Promise<CliOutcome> {
  const homeDir = optionValue(args, '--home') ?? glimmervoidHomeDir(os.homedir(), process.env);
  const worktreeDir = await worktreeRootOf(process.cwd());
  const repoKey = worktreeDir ? await repoKeyOf(worktreeDir) : null;
  if (!worktreeDir || !repoKey) return { ok: false, error: `${process.cwd()} is not inside a git repository` };
  const config = configPathOrError(optionValue(args, '--config'));
  const mainlineSha = await mainlineShaForCli(repoKey, config.ok ? config.configPath : null);
  if (!mainlineSha) return { ok: false, error: `${repoKey} has no mainline commit to check against` };
  const checked = await checkWorktree({ client: createCodemapClient(), homeDir, worktreeDir, mainlineSha });
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, text: checked.text, exitCode: checked.isRefusing ? 1 : 0 };
}

function isOperatorCodemapCommand(args: readonly string[]): boolean {
  return OPERATOR_CODEMAP_ACTIONS.has(args[0] ?? '');
}

async function runOperatorCodemapCli(args: readonly string[]): Promise<number> {
  const runners: Record<string, (actionArgs: readonly string[]) => Promise<CliOutcome>> = { setup: runSetup, allow: runAllow, shrink: runShrink, check: runCheck };
  const outcome = await (runners[args[0] ?? ''] ?? (async () => ({ ok: false as const, error: USAGE })))(args).catch((error: unknown) => ({ ok: false as const, error: errorMessage(error) }));
  if (!outcome.ok) {
    console.error(`glimmervoid codemap: ${outcome.error}`);
    return 1;
  }
  console.log(outcome.text);
  return outcome.exitCode ?? 0;
}

export { isOperatorCodemapCommand, runOperatorCodemapCli };

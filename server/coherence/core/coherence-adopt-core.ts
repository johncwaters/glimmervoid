import { CoherenceAdoptError, ProjectCoherenceAdoptRequest } from '../../../shared/contracts/coherence.ts';
import { COHERENCE_CONFIG_FILENAME } from './coherence-config-core.ts';
import { COHERENCE_NATIVE_CONTROL_FILES } from './coherence-session-core.ts';
import type { CoherenceHost } from './coherence-session-core.ts';

export const COHERENCE_PACKAGE_NAME = '@danilocampos/coherence';
export const COHERENCE_ADOPT_HOSTS: readonly CoherenceHost[] = Object.freeze(['claude', 'codex']);
const COHERENCE_ADOPT_IGNORED_NAMES = Object.freeze(['node_modules', '.git', 'dist', '.turbo', '.wrangler', 'tests', 'test', '__tests__']);
export const COHERENCE_ADOPT_CONFIG_TEXT = `${JSON.stringify({ ignore: COHERENCE_ADOPT_IGNORED_NAMES }, null, 2)}\n`;
const COHERENCE_ADOPT_COMMIT_SUBJECT = 'chore: adopt Coherence';

export const COHERENCE_ADOPT_TIMEOUT_MS = Object.freeze({ npmInstall: 120_000, hooksInstall: 30_000, push: 60_000 });
const COHERENCE_ADOPT_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const COHERENCE_ADOPT_NPM_FILES = Object.freeze(['package.json', 'package-lock.json']);
export const COHERENCE_ADOPT_NPM_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const COHERENCE_ADOPT_NODE_MODULES_PATHSPECS = Object.freeze([':(glob)**/node_modules', ':(glob)**/node_modules/**']);
export const COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER = Object.freeze({ relativePath: ['node_modules', '.bin', 'coherence-hook'], text: '#!/bin/sh\nexit 1\n', mode: 0o755 });

export const COHERENCE_ADOPT_CONTROL_FILES: readonly string[] = Object.freeze(COHERENCE_ADOPT_HOSTS.flatMap((host) => COHERENCE_NATIVE_CONTROL_FILES[host]));
const ADOPT_PACKAGE_FILES = Object.freeze([...COHERENCE_ADOPT_NPM_FILES, '.gitignore']);
const ADOPT_COMMITTABLE_PATHS: ReadonlySet<string> = new Set([
  COHERENCE_CONFIG_FILENAME, ...ADOPT_PACKAGE_FILES, ...COHERENCE_ADOPT_CONTROL_FILES,
]);
const ADOPT_REQUIRED_PATHS = Object.freeze([COHERENCE_CONFIG_FILENAME, ...COHERENCE_ADOPT_CONTROL_FILES]);

export const COHERENCE_ADOPT_NO_SYMLINK_PATHS = Object.freeze([
  ...ADOPT_PACKAGE_FILES, 'node_modules', '.claude', '.codex', ...COHERENCE_ADOPT_CONTROL_FILES,
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type CoherenceAdoptStep = 'fetch' | 'npm-install' | 'hooks-install' | 'commit' | 'push';
type CoherenceAdoptRequestVerdict = { ok: true; projectId: string } | { ok: false; error: CoherenceAdoptError };
type CoherenceAdoptPathsVerdict = { ok: true; paths: string[] } | { ok: false; error: CoherenceAdoptError; unexpectedPaths: string[]; missingPaths: string[] };

export function judgeCoherenceAdoptRequest(request: unknown): CoherenceAdoptRequestVerdict {
  const parsed = ProjectCoherenceAdoptRequest.safeParse(request);
  if (parsed.success) return { ok: true, projectId: parsed.data.projectId };
  const confirm: unknown = typeof request === 'object' && request !== null ? Reflect.get(request, 'confirm') : undefined;
  return { ok: false, error: confirm === true ? CoherenceAdoptError.enum.invalidRequest : CoherenceAdoptError.enum.notConfirmed };
}

export function coherenceAdoptStepFailure(step: CoherenceAdoptStep, { isTimedOut }: { isTimedOut: boolean }): CoherenceAdoptError {
  if (isTimedOut) return CoherenceAdoptError.enum.timedOut;
  if (step === 'npm-install') return CoherenceAdoptError.enum.npmInstallFailed;
  if (step === 'hooks-install') return CoherenceAdoptError.enum.hooksInstallFailed;
  if (step === 'push') return CoherenceAdoptError.enum.pushRejected;
  return CoherenceAdoptError.enum.failed;
}

export function isExactCoherenceVersion(version: unknown): version is string {
  return typeof version === 'string' && EXACT_VERSION.test(version);
}

export function coherenceNpmLockfileArgs(emptyUserconfigPath: string): string[] {
  return ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${COHERENCE_ADOPT_NPM_REGISTRY}`, `--userconfig=${emptyUserconfigPath}`];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsedJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function packageTextWithCoherencePin(existingPackageText: string | null, version: string): string | null {
  if (!isExactCoherenceVersion(version)) throw new Error(`not an exact Coherence version: ${version}`);
  const manifest = existingPackageText === null ? { private: true } : parsedJsonOrNull(existingPackageText);
  if (!isPlainObject(manifest)) return null;
  const dependencies = manifest.dependencies;
  if (isPlainObject(dependencies) && Object.hasOwn(dependencies, COHERENCE_PACKAGE_NAME)) {
    return `${JSON.stringify({ ...manifest, dependencies: { ...dependencies, [COHERENCE_PACKAGE_NAME]: version } }, null, 2)}\n`;
  }
  const devDependencies = manifest.devDependencies ?? {};
  if (!isPlainObject(devDependencies)) return null;
  return `${JSON.stringify({ ...manifest, devDependencies: { ...devDependencies, [COHERENCE_PACKAGE_NAME]: version } }, null, 2)}\n`;
}

export function coherenceHooksInstallArgs(host: CoherenceHost): string[] {
  return ['hooks', 'install', '--host', host];
}

export function coherencePushArgs(sha: string, branch: string): string[] {
  return ['push', '--porcelain', 'origin', `${sha}:refs/heads/${branch}`];
}

export function coherenceAdoptCommitMessage(version: string): { subject: string; body: string } {
  return {
    subject: COHERENCE_ADOPT_COMMIT_SUBJECT,
    body: `Pins ${COHERENCE_PACKAGE_NAME}@${version} in package.json with coherence.config.json and the Claude and Codex lifecycle controls that coherence hooks install wrote.`,
  };
}

export const COHERENCE_JOURNAL_TRANSIENT_PROBES = Object.freeze(['.coherence/activity/probe.jsonl', '.coherence/read-traces/probe.jsonl']);
const COHERENCE_JOURNAL_RECORDS = Object.freeze([
  { keptPath: '.coherence/decisions/', probePath: '.coherence/decisions/probe.jsonl' },
  { keptPath: '.coherence/defects/', probePath: '.coherence/defects/probe.jsonl' },
  { keptPath: '.coherence/status.json', probePath: '.coherence/status.json' },
  { keptPath: '.coherence/calibration/', probePath: '.coherence/calibration/probe.jsonl' },
  { keptPath: '.coherence/experiments/', probePath: '.coherence/experiments/probe.jsonl' },
  { keptPath: '.coherence/work/', probePath: '.coherence/work/probe.jsonl' },
  { keptPath: '.coherence/consequences/', probePath: '.coherence/consequences/probe.jsonl' },
  { keptPath: '.coherence/hooks/', probePath: '.coherence/hooks/SessionStart.append.md' },
]);
export const COHERENCE_JOURNAL_RECORD_PROBES = Object.freeze(COHERENCE_JOURNAL_RECORDS.map((record) => record.probePath));
const COHERENCE_JOURNAL_IGNORE_LINES = Object.freeze(['.coherence/*', ...COHERENCE_JOURNAL_RECORDS.map((record) => `!${record.keptPath}`)]);

export function ignoredJournalRecordPaths(ignoredProbePaths: readonly string[]): string[] {
  return COHERENCE_JOURNAL_RECORDS.filter((record) => ignoredProbePaths.includes(record.probePath)).map((record) => record.keptPath);
}

export function adoptGitignoreText(existingText: string | null, { isNodeModulesIgnored, isTransientJournalIgnored }: { isNodeModulesIgnored: boolean; isTransientJournalIgnored: boolean }): string | null {
  const missingLines = [...(isNodeModulesIgnored ? [] : ['node_modules/']), ...(isTransientJournalIgnored ? [] : COHERENCE_JOURNAL_IGNORE_LINES)];
  if (missingLines.length === 0) return null;
  const currentText = existingText ?? '';
  const separator = currentText === '' || currentText.endsWith('\n') ? '' : '\n';
  return `${currentText}${separator}${missingLines.join('\n')}\n`;
}

export function pathsFromPorcelainStatus(statusOutput: string): string[] {
  return statusOutput.split('\0').flatMap((record) => (record.length > 3 ? [record.slice(3)] : []));
}

function isUnderNodeModules(relativePath: string): boolean {
  return relativePath.split('/').includes('node_modules');
}

export function judgeCoherenceAdoptTrackedPaths(trackedPaths: readonly string[]): CoherenceAdoptError | null {
  return trackedPaths.some(isUnderNodeModules) ? CoherenceAdoptError.enum.tracksNodeModules : null;
}

export function judgeCoherenceAdoptPaths(changedPaths: readonly string[]): CoherenceAdoptPathsVerdict {
  const unexpectedPaths = changedPaths.filter((changedPath) => isUnderNodeModules(changedPath) || !ADOPT_COMMITTABLE_PATHS.has(changedPath));
  const missingPaths = ADOPT_REQUIRED_PATHS.filter((requiredPath) => !changedPaths.includes(requiredPath));
  if (unexpectedPaths.length > 0 || missingPaths.length > 0) return { ok: false, error: CoherenceAdoptError.enum.hooksInstallFailed, unexpectedPaths, missingPaths };
  return { ok: true, paths: [...changedPaths].sort() };
}

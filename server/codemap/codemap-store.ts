import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CodemapSetup, DesignSpecForMap, StoredCodemapSetup } from '../../shared/contracts/codemap.ts';
import { errorCode, errorMessage } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { writeTextAtomicSync } from '../json-file.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { CODEMAP_TUNABLES } from '../core/codemap-graph-core.ts';
import { DEFAULT_BRANCH_FALLBACKS, defaultBranchFromRemoteHead } from '../core/integration-branch-core.ts';
import { CO_CHANGE_LOG_ARGS, parseCoChangeLog } from '../core/co-change-core.ts';
import type { CommitFiles } from '../core/co-change-core.ts';

const SETUP_FOLDER_NAME = 'codemap';
const SETUP_FILE_NAME = 'setup.json';
const REPO_KEY_HASH_LENGTH = 12;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

type CodemapSetupLookup =
  | { kind: 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; setup: CodemapSetup };

async function gitText(cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<string | null> {
  return execFileAsync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv } })
    .then(({ stdout }) => stdout, () => null);
}

async function repoKeyOf(directory: string): Promise<string | null> {
  const commonDir = (await gitText(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!commonDir) return null;
  const mainCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return fsp.realpath(mainCheckout).catch(() => mainCheckout);
}

async function fileTextAtCommit(directory: string, sha: string, repoPath: string): Promise<string | null> {
  return gitText(directory, ['show', `${sha}:${repoPath}`]);
}

async function worktreeRootOf(directory: string): Promise<string | null> {
  return (await gitText(directory, ['rev-parse', '--show-toplevel']))?.trim() || null;
}

function setupPathOf(homeDir: string, repoKey: string): string {
  const readableName = path.basename(repoKey).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'repo';
  const keyHash = crypto.createHash('sha256').update(repoKey).digest('hex').slice(0, REPO_KEY_HASH_LENGTH);
  return path.join(homeDir, SETUP_FOLDER_NAME, `${readableName}-${keyHash}`, SETUP_FILE_NAME);
}

function setupLookupOf(setupPath: string, repoKey: string, text: string | null): CodemapSetupLookup {
  if (text === null) return { kind: 'none' };
  const parsed = StoredCodemapSetup.safeParse(parseJsonOrNull(text));
  if (!parsed.success) return { kind: 'invalid', message: `${setupPath} is not a valid code map setup: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}` };
  if (parsed.data.repo !== repoKey) return { kind: 'invalid', message: `${setupPath} belongs to ${parsed.data.repo}, not ${repoKey}` };
  return { kind: 'ok', setup: parsed.data };
}

async function readCodemapSetup(homeDir: string, repoKey: string): Promise<CodemapSetupLookup> {
  const setupPath = setupPathOf(homeDir, repoKey);
  const text = await fsp.readFile(setupPath, 'utf8').catch((error: unknown) => (errorCode(error) === 'ENOENT' ? null : { error }));
  if (text !== null && typeof text !== 'string') return { kind: 'invalid', message: `${setupPath} could not be read: ${errorMessage(text.error)}` };
  return setupLookupOf(setupPath, repoKey, text);
}

function readSetupTextSync(setupPath: string): string | null | { error: unknown } {
  try {
    return fs.readFileSync(setupPath, 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? null : { error };
  }
}

function writeSetupSync(setupPath: string, setup: CodemapSetup): string | null {
  try {
    writeTextAtomicSync(setupPath, `${JSON.stringify(CodemapSetup.parse(setup), null, 2)}\n`, { mkdir: true });
    return null;
  } catch (error) {
    return `${setupPath} could not be written: ${errorMessage(error)}`;
  }
}

function updateCodemapSetup(homeDir: string, repoKey: string, change: (current: CodemapSetup | null) => CodemapSetup | null): CodemapSetupLookup {
  const setupPath = setupPathOf(homeDir, repoKey);
  const text = readSetupTextSync(setupPath);
  if (text !== null && typeof text !== 'string') return { kind: 'invalid', message: `${setupPath} could not be read: ${errorMessage(text.error)}` };
  const current = setupLookupOf(setupPath, repoKey, text);
  if (current.kind === 'invalid') return current;
  const next = change(current.kind === 'ok' ? current.setup : null);
  if (!next) return current;
  const writeError = writeSetupSync(setupPath, next);
  return writeError ? { kind: 'invalid', message: writeError } : { kind: 'ok', setup: next };
}


async function untrackedPathsWithinCapsOf(worktreeDir: string): Promise<string[]> {
  const listed = await gitText(worktreeDir, ['ls-files', '--others', '--exclude-standard', '-z']);
  const candidates = (listed ?? '').split(String.fromCharCode(0)).filter(Boolean).slice(0, CODEMAP_TUNABLES.maxSourceFiles);
  const sizes = await Promise.all(candidates.map(async (repoPath) => (await fsp.stat(path.join(worktreeDir, repoPath)).catch(() => null))?.size ?? Number.POSITIVE_INFINITY));
  return candidates.filter((_repoPath, index) => (sizes[index] ?? Number.POSITIVE_INFINITY) <= CODEMAP_TUNABLES.maxFileBytes);
}

async function workingTreeShaOf(worktreeDir: string): Promise<string | null> {
  const indexPath = (await gitText(worktreeDir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))?.trim();
  if (!indexPath) return null;
  const scratchPrefix = path.join(os.tmpdir(), `glimmervoid-codemap-${crypto.randomUUID()}`);
  const scratchIndexPath = `${scratchPrefix}.index`;
  const untrackedListPath = `${scratchPrefix}.paths`;
  try {
    await fsp.copyFile(indexPath, scratchIndexPath).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    const scratchIndex = { GIT_INDEX_FILE: scratchIndexPath };
    if (await gitText(worktreeDir, ['add', '--update', '--', '.'], scratchIndex) === null) return null;
    const untrackedPaths = await untrackedPathsWithinCapsOf(worktreeDir);
    await fsp.writeFile(untrackedListPath, untrackedPaths.join(String.fromCharCode(0)));
    if (untrackedPaths.length > 0 && await gitText(worktreeDir, ['add', `--pathspec-from-file=${untrackedListPath}`, '--pathspec-file-nul'], scratchIndex) === null) return null;
    const treeSha = (await gitText(worktreeDir, ['write-tree'], scratchIndex))?.trim() ?? '';
    return /^[0-9a-f]{40}$/.test(treeSha) ? treeSha : null;
  } finally {
    await Promise.all([fsp.rm(scratchIndexPath, { force: true }), fsp.rm(untrackedListPath, { force: true })]);
  }
}

async function judgedTreeOf(worktreeDir: string, mainlineSha: string, commitSha: string | null): Promise<{ treeSha: string; changedPaths: Set<string> } | null> {
  const treeSha = commitSha ?? await workingTreeShaOf(worktreeDir);
  const forkSha = (await gitText(worktreeDir, ['merge-base', mainlineSha, commitSha ?? 'HEAD']))?.trim();
  if (!treeSha || !forkSha) return null;
  const listed = await gitText(worktreeDir, ['diff', '--name-only', '--relative', '-z', '--no-renames', forkSha, treeSha]);
  if (listed === null) return null;
  return { treeSha, changedPaths: new Set(listed.split(String.fromCharCode(0)).filter(Boolean)) };
}

async function revParse(directory: string, ref: string): Promise<string | null> {
  const sha = (await gitText(directory, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim() ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function mainlineShaOf(directory: string, mainlineBranch: string | null): Promise<string | null> {
  if (!mainlineBranch) return revParse(directory, 'HEAD');
  return await revParse(directory, `refs/remotes/origin/${mainlineBranch}`) ?? await revParse(directory, `refs/heads/${mainlineBranch}`) ?? revParse(directory, 'HEAD');
}

async function recentCommitsOf(directory: string, sha: string): Promise<CommitFiles[] | null> {
  const logText = await gitText(directory, ['-c', 'core.quotePath=false', ...CO_CHANGE_LOG_ARGS, sha]);
  return logText === null ? null : parseCoChangeLog(logText);
}

const TICKET_TRAILER_LOG_ARGS = Object.freeze(['log', '--no-merges', '--format=%(trailers:key=Ticket,valueonly)', '-n', '2000']);

async function ticketTrailersOf(directory: string, sha: string): Promise<Set<string> | null> {
  const logText = await gitText(directory, [...TICKET_TRAILER_LOG_ARGS, sha]);
  return logText === null ? null : new Set(logText.split('\n').map((line) => line.trim()).filter(Boolean));
}

type DesignSpecLookup = { kind: 'none' } | { kind: 'invalid'; message: string } | { kind: 'ok'; spec: DesignSpecForMap };

async function readDesignSpec(specsRoot: string, repoName: string, slug: string): Promise<DesignSpecLookup> {
  const specPath = path.join(specsRoot, repoName, `${slug}.json`);
  const text = await fsp.readFile(specPath, 'utf8').catch((error: unknown) => (errorCode(error) === 'ENOENT' ? null : { error }));
  if (text === null) return { kind: 'none' };
  if (typeof text !== 'string') return { kind: 'invalid', message: `${specPath} could not be read: ${errorMessage(text.error)}` };
  const parsed = DesignSpecForMap.safeParse(parseJsonOrNull(text));
  if (!parsed.success) return { kind: 'invalid', message: `${specPath} is not a design spec the map can draw: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}` };
  return { kind: 'ok', spec: parsed.data };
}

async function guessedDefaultBranchOf(directory: string): Promise<string | null> {
  const remoteHead = (await gitText(directory, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim() ?? '';
  const fromRemoteHead = defaultBranchFromRemoteHead(remoteHead);
  if (fromRemoteHead) return fromRemoteHead;
  for (const fallback of DEFAULT_BRANCH_FALLBACKS) {
    if (await revParse(directory, `refs/remotes/origin/${fallback}`) ?? await revParse(directory, `refs/heads/${fallback}`)) return fallback;
  }
  return null;
}

export { fileTextAtCommit, guessedDefaultBranchOf, mainlineShaOf, readCodemapSetup, readDesignSpec, recentCommitsOf, ticketTrailersOf, revParse, repoKeyOf, setupPathOf, updateCodemapSetup, judgedTreeOf, worktreeRootOf };

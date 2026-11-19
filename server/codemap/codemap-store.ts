import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CodemapSetup } from '../../shared/contracts/codemap.ts';
import { errorCode, errorMessage } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { writeTextAtomic } from '../json-file.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { DEFAULT_BRANCH_FALLBACKS, defaultBranchFromRemoteHead } from '../core/integration-branch-core.ts';

const SETUP_FOLDER_NAME = 'codemap';
const SETUP_FILE_NAME = 'setup.json';
const REPO_KEY_HASH_LENGTH = 12;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

type CodemapSetupLookup =
  | { kind: 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; setup: CodemapSetup };

async function gitText(cwd: string, args: readonly string[]): Promise<string | null> {
  return execFileAsync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    .then(({ stdout }) => stdout, () => null);
}

async function repoKeyOf(directory: string): Promise<string | null> {
  const commonDir = (await gitText(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim();
  if (!commonDir) return null;
  const mainCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return fsp.realpath(mainCheckout).catch(() => mainCheckout);
}

async function worktreeRootOf(directory: string): Promise<string | null> {
  return (await gitText(directory, ['rev-parse', '--show-toplevel']))?.trim() || null;
}

function setupPathOf(homeDir: string, repoKey: string): string {
  const readableName = path.basename(repoKey).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'repo';
  const keyHash = crypto.createHash('sha256').update(repoKey).digest('hex').slice(0, REPO_KEY_HASH_LENGTH);
  return path.join(homeDir, SETUP_FOLDER_NAME, `${readableName}-${keyHash}`, SETUP_FILE_NAME);
}

async function readCodemapSetup(homeDir: string, repoKey: string): Promise<CodemapSetupLookup> {
  const setupPath = setupPathOf(homeDir, repoKey);
  const text = await fsp.readFile(setupPath, 'utf8').catch((error: unknown) => (errorCode(error) === 'ENOENT' ? null : { error }));
  if (text === null) return { kind: 'none' };
  if (typeof text !== 'string') return { kind: 'invalid', message: `${setupPath} could not be read: ${errorMessage(text.error)}` };
  const parsed = CodemapSetup.safeParse(parseJsonOrNull(text));
  if (!parsed.success) return { kind: 'invalid', message: `${setupPath} is not a valid code map setup: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}` };
  if (parsed.data.repo !== repoKey) return { kind: 'invalid', message: `${setupPath} belongs to ${parsed.data.repo}, not ${repoKey}` };
  return { kind: 'ok', setup: parsed.data };
}

async function writeCodemapSetup(homeDir: string, setup: CodemapSetup): Promise<string> {
  const setupPath = setupPathOf(homeDir, setup.repo);
  await fsp.mkdir(path.dirname(setupPath), { recursive: true });
  await writeTextAtomic(setupPath, `${JSON.stringify(CodemapSetup.parse(setup), null, 2)}\n`);
  return setupPath;
}

async function changedPathsSince(worktreeDir: string, baseSha: string): Promise<Set<string> | null> {
  const listed = await gitText(worktreeDir, ['diff', '--name-only', '--relative', '-z', '--no-renames', `${baseSha}...HEAD`]);
  if (listed === null) return null;
  return new Set(listed.split(String.fromCharCode(0)).filter(Boolean));
}

async function revParse(directory: string, ref: string): Promise<string | null> {
  const sha = (await gitText(directory, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim() ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function mainlineShaOf(directory: string, mainlineBranch: string | null): Promise<string | null> {
  if (!mainlineBranch) return revParse(directory, 'HEAD');
  return await revParse(directory, `refs/remotes/origin/${mainlineBranch}`) ?? await revParse(directory, `refs/heads/${mainlineBranch}`) ?? revParse(directory, 'HEAD');
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

export { changedPathsSince, guessedDefaultBranchOf, mainlineShaOf, readCodemapSetup, revParse, repoKeyOf, setupPathOf, worktreeRootOf, writeCodemapSetup };

import '../../harness/support/disable-telemetry.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_SECRET_BINDINGS } from '../../server/core/config-secrets-core.ts';
import { GIT_CREDENTIAL_URL_ENV } from '../../shared/contracts/session.ts';
import { VENDOR_HOME_VARS } from './transcript-homes.ts';

const REMOVAL_ATTEMPTS_WHILE_A_LATE_WRITER_FINISHES = 40;
const DELAY_BETWEEN_REMOVAL_ATTEMPTS_MS = 25;

function isDirectoryNotEmptyError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY';
}

function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function removeFolderOutlastingLateWriters(folder: string): void {
  for (let attempt = 1; attempt <= REMOVAL_ATTEMPTS_WHILE_A_LATE_WRITER_FINISHES; attempt++) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isDirectoryNotEmptyError(error)) throw error;
    }
    sleepSync(DELAY_BETWEEN_REMOVAL_ATTEMPTS_MS);
  }
}

function mintFolderRemovedOnExit(prefix: string): string {
  const mintedFolder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => removeFolderOutlastingLateWriters(mintedFolder));
  return mintedFolder;
}

function resolveIsolatedTestHome(): string {
  const sharedByParent = process.env.GLIMMERVOID_TEST_HOME;
  if (sharedByParent) return sharedByParent;

  const mintedHome = mintFolderRemovedOnExit('glimmervoid-test-home-');
  process.env.GLIMMERVOID_TEST_HOME = mintedHome;
  return mintedHome;
}

for (const binding of ENV_SECRET_BINDINGS) delete process.env[binding.environmentVariable];
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

process.env.GLIMMERVOID_HOME = resolveIsolatedTestHome();
process.env.CLAUDE_CONFIG_DIR = path.join(process.env.GLIMMERVOID_HOME, 'claude-config');
for (const vendorHomeVariable of VENDOR_HOME_VARS.filter((name) => name !== 'CLAUDE_CONFIG_DIR')) process.env[vendorHomeVariable] = path.join(process.env.GLIMMERVOID_HOME, vendorHomeVariable.toLowerCase());
process.env.ANTIGRAVITY_BRAIN_DIR = path.join(process.env.GLIMMERVOID_HOME, 'antigravity-brain');
process.env.PI_CODING_AGENT_DIR = path.join(process.env.GLIMMERVOID_HOME, 'pi-agent');
delete process.env.PI_CODING_AGENT_SESSION_DIR;

const isolatedTestTemp = mintFolderRemovedOnExit('glimmervoid-test-tmp-');
for (const temporaryFolderVariable of ['TMPDIR', 'TEMP', 'TMP']) process.env[temporaryFolderVariable] = isolatedTestTemp;

const INHERITED_GIT_REACH_VARIABLES = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'SSH_ASKPASS', GIT_CREDENTIAL_URL_ENV];
const isInheritedGitConfigEntry = (name: string): boolean => name.startsWith('GIT_CONFIG_KEY_') || name.startsWith('GIT_CONFIG_VALUE_');
for (const name of Object.keys(process.env).filter(isInheritedGitConfigEntry)) delete process.env[name];
for (const name of INHERITED_GIT_REACH_VARIABLES) delete process.env[name];

const isolatedGitConfig = path.join(process.env.GLIMMERVOID_HOME, 'gitconfig');
if (!fs.existsSync(isolatedGitConfig)) fs.writeFileSync(isolatedGitConfig, '[user]\n\tname = Glimmervoid Test\n\temail = test@glimmervoid.invalid\n');
process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';

function commandNameOf(entryName: string): string {
  return process.platform === 'win32' ? path.parse(entryName).name : entryName;
}

function listFolderEntries(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
}

function linkEntry(target: string, linkPath: string): void {
  try {
    fs.symlinkSync(target, linkPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM') || !fs.statSync(target).isFile()) throw error;
    fs.copyFileSync(target, linkPath);
  }
}

function agentFreeCopyOf(folder: string, agentCommandNames: ReadonlySet<string>): string {
  const entries = listFolderEntries(folder);
  if (!entries.some((entryName) => agentCommandNames.has(commandNameOf(entryName)))) return folder;
  const agentFreeFolder = mintFolderRemovedOnExit('glimmervoid-test-bin-');
  for (const entryName of entries.filter((candidate) => !agentCommandNames.has(commandNameOf(candidate)))) linkEntry(path.join(folder, entryName), path.join(agentFreeFolder, entryName));
  return agentFreeFolder;
}

if (process.env.GLIMMERVOID_TEST_PATH_WITHOUT_AGENTS !== '1') {
  const { BUILT_IN_AGENTS } = await import('../../session/adapters/index.ts');
  const agentCommandNames = new Set(BUILT_IN_AGENTS.filter(({ tier }) => tier !== 'shell').map(({ adapter }) => adapter.commandName));
  const pathFolders = (process.env.PATH ?? '').split(path.delimiter).filter((folder) => folder !== '');
  process.env.PATH = pathFolders.map((folder) => agentFreeCopyOf(folder, agentCommandNames)).join(path.delimiter);
  process.env.GLIMMERVOID_TEST_PATH_WITHOUT_AGENTS = '1';
}

import '../../harness/support/disable-telemetry.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_SECRET_BINDINGS } from '../../server/core/config-secrets-core.ts';
import { GIT_CREDENTIAL_URL_ENV } from '../../shared/contracts/session.ts';

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

process.env.GLIMMERVOID_HOME = resolveIsolatedTestHome();
process.env.CLAUDE_CONFIG_DIR = path.join(process.env.GLIMMERVOID_HOME, 'claude-config');

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

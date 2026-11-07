import '../../harness/support/disable-telemetry.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_SECRET_BINDINGS } from '../../server/core/config-secrets-core.ts';

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

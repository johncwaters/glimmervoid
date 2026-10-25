import '../../harness/support/disable-telemetry.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_SECRET_BINDINGS } from '../../server/core/config-secrets-core.ts';

function mintFolderRemovedOnExit(prefix: string): string {
  const mintedFolder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => {
    fs.rmSync(mintedFolder, { recursive: true, force: true });
  });
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

const isolatedTestTemp = mintFolderRemovedOnExit('glimmervoid-test-tmp-');
for (const temporaryFolderVariable of ['TMPDIR', 'TEMP', 'TMP']) process.env[temporaryFolderVariable] = isolatedTestTemp;

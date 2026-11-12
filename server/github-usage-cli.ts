import fs from 'node:fs';

import { GithubUsageSnapshot } from '../shared/contracts/github-usage.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { formatGithubUsage } from './github/core/github-usage-core.ts';
import { githubUsageFilePath } from './github/github-usage-ledger.ts';
import { clock } from '../shared/clock.ts';

function readSnapshotText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function runGithubUsageCli({ isJson, homeDir = glimmervoidHomeDir(), now = clock.nowMs }: { isJson: boolean; homeDir?: string; now?: () => number }): Promise<number> {
  const filePath = githubUsageFilePath(homeDir);
  const snapshotText = readSnapshotText(filePath);
  if (snapshotText === null) {
    console.error(`No GitHub usage snapshot at ${filePath} yet. A running Glimmervoid writes it every minute.`);
    return 1;
  }
  const snapshot = GithubUsageSnapshot.safeParse(parseJsonOrNull(snapshotText));
  if (!snapshot.success) {
    console.error(`${filePath} is not a GitHub usage snapshot this version can read.`);
    return 1;
  }
  console.log(isJson ? JSON.stringify(snapshot.data, null, 2) : formatGithubUsage(snapshot.data, now()));
  return 0;
}

export { runGithubUsageCli };

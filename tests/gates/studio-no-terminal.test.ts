import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

const STUDIO_CODE_PATTERN = /^(?:(?:public|server)\/board-session\/.+\.(?:ts|tsx|js|mjs|css)|mcp\/core\/studio-playbook\.ts)$/;
const TERMINAL_PATTERN = /terminal/i;
const RULE_AND_FIX = 'Studio rule: Studio runs on ACP only and no Studio code path names, shows, or waits on a terminal. Fix: remove the terminal reference and surface failures or re-authentication directly on the Studio card or dock.';

function findTerminalLines(relativePaths: string[]): string[] {
  const offenders: string[] = [];
  for (const relativePath of relativePaths) {
    const lines = readTracked(relativePath).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!TERMINAL_PATTERN.test(line)) continue;
      offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    }
  }
  return offenders;
}

test('no Studio code path names a terminal', () => {
  const studioCodeFiles = trackedFiles(STUDIO_CODE_PATTERN);
  assert.ok(studioCodeFiles.length > 0, 'expected Studio code files to match so this gate cannot pass vacuously');
  assert.ok(studioCodeFiles.includes('mcp/core/studio-playbook.ts'), 'expected mcp/core/studio-playbook.ts in the Studio no-terminal gate');
  const offenders = findTerminalLines(studioCodeFiles);
  assert.deepEqual(offenders, [], `${RULE_AND_FIX}\n${offenders.join('\n')}`);
});

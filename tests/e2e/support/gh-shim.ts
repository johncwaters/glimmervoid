import fs from 'node:fs';
import path from 'node:path';

interface GhShim {
  directory: string;
  calls: () => string[];
}

const NOTIFICATIONS_ANSWER = String.raw`HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n[]\n`;

function shimScript(callLogPath: string): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${callLogPath}'`,
    'case "$*" in',
    `  *"api -i -X GET notifications"*) printf '${NOTIFICATIONS_ANSWER}'; exit 0 ;;`,
    `  "api user"*) printf '{"login":"e2e-viewer"}\\n'; exit 0 ;;`,
    'esac',
    `echo "gh shim: no canned answer for: $*" >&2`,
    'exit 1',
    '',
  ].join('\n');
}

function installGhShim(parentDirectory: string): GhShim {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'gh-shim-'));
  const callLogPath = path.join(directory, 'calls.log');
  fs.writeFileSync(callLogPath, '');
  fs.writeFileSync(path.join(directory, 'gh'), shimScript(callLogPath), { mode: 0o755 });
  return {
    directory,
    calls: () => fs.readFileSync(callLogPath, 'utf8').split('\n').filter((line) => line !== ''),
  };
}

export { installGhShim };
export type { GhShim };

import fs from 'node:fs';
import os from 'node:os';

import { formatPathNotice, npmGlobalBinDir, onPath } from '../bin/path-doctor.ts';
import { guardrailsInstallNotice } from '../server/guardrails/core/guardrails-deps-core.ts';
import { probeGuardrailsDependencies } from '../server/guardrails/guardrails-deps.ts';

function openInstallTerminal(): number | null {
  if (process.env.npm_lifecycle_event !== 'postinstall') return null;
  try {
    return fs.openSync(process.platform === 'win32' ? 'CONOUT$' : '/dev/tty', 'w');
  } catch {
    return null;
  }
}

function writeInstallNotice(text: string): void {
  const terminal = openInstallTerminal();
  if (terminal === null) {
    process.stdout.write(text);
    return;
  }
  fs.writeSync(terminal, text);
  fs.closeSync(terminal);
}

function printPathNotice(): void {
  if (process.env.npm_config_global !== 'true') return;

  const platform = process.platform;
  const binDir = npmGlobalBinDir({ env: process.env, platform, homedir: os.homedir() });
  if (!binDir) return;

  const pathEnv = process.env.PATH || process.env.Path || '';
  const onPathFlag = onPath(binDir, { pathEnv, platform });
  writeInstallNotice(`\n${formatPathNotice({ installedBinDir: binDir, onPathFlag, platform })}\n\n`);
}

function printGuardrailsNotice(): void {
  const notice = guardrailsInstallNotice(probeGuardrailsDependencies());
  if (notice !== null) writeInstallNotice(`${notice}\n`);
}

try {
  printPathNotice();
} catch {
}
try {
  printGuardrailsNotice();
} catch {
}

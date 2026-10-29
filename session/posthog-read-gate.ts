import { readFileSync } from 'node:fs';

import { POSTHOG_READ_GATE_DENIAL_PREFIX, decidePosthogExec } from './core/posthog-read-gate-core.ts';

const BLOCKING_EXIT_CODE = 2;

function denialReason(): string | null {
  try {
    const serverName = process.argv[2];
    if (!serverName) return 'the gate was started without a server name';
    const decision = decidePosthogExec(JSON.parse(readFileSync(0, 'utf8')), serverName);
    return decision.allowed ? null : decision.reason;
  } catch (error) {
    return `the gate failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const reason = denialReason();
if (reason !== null) {
  process.stderr.write(`${POSTHOG_READ_GATE_DENIAL_PREFIX}${reason}\n`);
  process.exit(BLOCKING_EXIT_CODE);
}
process.exit(0);

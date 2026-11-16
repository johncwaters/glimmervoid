import { BINARY_RUN_SUBCOMMAND } from '../server/core/runtime-paths.ts';

const UNKNOWN_RUN_ENTRY_EXIT_CODE = 2;

type RelayExitCode = number | { code: number };

interface RelayModule {
  main(): Promise<RelayExitCode>;
}

const relayModuleLoaders: Record<string, () => Promise<RelayModule>> = {
  'hook-relay': () => import('../session/hook-relay.ts'),
  'command-hook-relay': () => import('../session/command-hook-relay.ts'),
  'statusline-relay': () => import('../session/statusline-relay.ts'),
  'hook-tool-relay': () => import('../session/hook-tool-relay.ts'),
  'mcp-bridge': () => import('../session/mcp-bridge.ts'),
};

const selfRunningEntryLoaders: Record<string, () => Promise<unknown>> = {
  'posthog-read-gate': () => import('../session/posthog-read-gate.ts'),
  'cc-safety-net': () => import('cc-safety-net-cli'),
};

function exitCodeOf(relayExitCode: RelayExitCode): number {
  return typeof relayExitCode === 'number' ? relayExitCode : relayExitCode.code;
}

async function runRelay(loadRelayModule: () => Promise<RelayModule>): Promise<never> {
  try {
    const relayModule = await loadRelayModule();
    process.exit(exitCodeOf(await relayModule.main()));
  } catch {
    process.exit(0);
  }
}

const [, , subcommand, entryName = '', ...entryArguments] = process.argv;
const loadRelayModule = relayModuleLoaders[entryName];
const loadSelfRunningEntry = selfRunningEntryLoaders[entryName];
if (subcommand !== BINARY_RUN_SUBCOMMAND || (!loadRelayModule && !loadSelfRunningEntry)) {
  process.stderr.write(`glimmervoid-relay: no run entry named ${entryName}\n`);
  process.exit(UNKNOWN_RUN_ENTRY_EXIT_CODE);
}
process.argv = [process.execPath, entryName, ...entryArguments];
if (loadRelayModule) await runRelay(loadRelayModule);
if (loadSelfRunningEntry) await loadSelfRunningEntry();

import { BINARY_RUN_SUBCOMMAND, relayExecutableBeside } from '../server/core/runtime-paths.ts';

async function routeNodePtyToExtractedCopy(): Promise<void> {
  const { extractNodePtyFromBinary } = await import('../server/runtime-paths.ts');
  const extractedEntry = extractNodePtyFromBinary();
  if (!extractedEntry) return;
  const { registerHooks } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const extractedEntryUrl = pathToFileURL(extractedEntry).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'node-pty') return nextResolve(specifier, context);
      return { url: extractedEntryUrl, format: 'commonjs', shortCircuit: true };
    },
  });
}

async function routeNodePtyOrReport(): Promise<void> {
  try {
    await routeNodePtyToExtractedCopy();
  } catch (err) {
    process.stderr.write(`glimmervoid: node-pty stays inside the binary, terminals may not spawn: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function runCli(): Promise<void> {
  await routeNodePtyOrReport();
  await import('./glimmervoid.ts');
}

async function forwardRunFromPreRelaySessionsToRelay(relayArguments: string[]): Promise<never> {
  const { spawn } = await import('../server/child-process-safe.ts');
  const relayProcess = spawn(relayExecutableBeside(process.execPath), relayArguments, { stdio: 'inherit' });
  const relayExitCode = await new Promise<number>((resolve) => {
    relayProcess.on('error', () => resolve(RELAY_UNREACHABLE_EXIT_CODE));
    relayProcess.on('close', (exitCode: number | null) => resolve(exitCode ?? RELAY_UNREACHABLE_EXIT_CODE));
  });
  process.exit(relayExitCode);
}

const RELAY_UNREACHABLE_EXIT_CODE = 2;
const relayArguments = process.argv.slice(2);
if (relayArguments[0] === BINARY_RUN_SUBCOMMAND) await forwardRunFromPreRelaySessionsToRelay(relayArguments);
await runCli();

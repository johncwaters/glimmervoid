import fs from 'node:fs';
import { BINARY_RUN_SUBCOMMAND, relayExecutableBeside } from '../server/core/runtime-paths.ts';

const UNKNOWN_RUN_ENTRY_EXIT_CODE = 2;
const SESSION_RUN_ENTRY_NAMES = new Set(['hook-relay', 'command-hook-relay', 'statusline-relay', 'hook-tool-relay', 'mcp-bridge', 'posthog-read-gate']);
const PACKAGE_BIN_RUN_ENTRY_NAMES = new Set(['cc-safety-net']);

async function entryFileOf(entryName: string): Promise<string | null> {
  const { relayPath, resolvePackageBin } = await import('../server/runtime-paths.ts');
  if (SESSION_RUN_ENTRY_NAMES.has(entryName)) return relayPath(entryName);
  if (PACKAGE_BIN_RUN_ENTRY_NAMES.has(entryName)) return resolvePackageBin(entryName, entryName);
  return null;
}

async function runEntryInProcess(entryName: string, entryArguments: readonly string[]): Promise<void> {
  const entryFile = await entryFileOf(entryName);
  if (!entryFile) {
    process.stderr.write(`glimmervoid: no run entry named ${entryName}\n`);
    process.exit(UNKNOWN_RUN_ENTRY_EXIT_CODE);
  }
  process.argv = [process.execPath, entryFile, ...entryArguments];
  const { pathToFileURL } = await import('node:url');
  await import(pathToFileURL(entryFile).href);
}

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

async function forwardRunToRelay(relayArguments: string[]): Promise<never> {
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
const isRunSubcommand = relayArguments[0] === BINARY_RUN_SUBCOMMAND;
const hasRelayBesideExecutable = fs.existsSync(relayExecutableBeside(process.execPath));
if (isRunSubcommand && hasRelayBesideExecutable) await forwardRunToRelay(relayArguments);
if (isRunSubcommand) await runEntryInProcess(relayArguments[1] ?? '', relayArguments.slice(2));
if (!isRunSubcommand) await runCli();

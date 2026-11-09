const BINARY_RUN_SUBCOMMAND = '__run';
const UNKNOWN_RUN_ENTRY_EXIT_CODE = 2;
const RELAY_RUN_ENTRIES = new Set(['hook-relay', 'command-hook-relay', 'statusline-relay', 'hook-tool-relay', 'posthog-read-gate']);
const PACKAGE_BIN_RUN_ENTRIES = new Set(['cc-safety-net']);

async function entryFileOf(entryName: string): Promise<string | null> {
  const { relayPath, resolvePackageBin } = await import('../server/runtime-paths.ts');
  if (RELAY_RUN_ENTRIES.has(entryName)) return relayPath(entryName);
  if (PACKAGE_BIN_RUN_ENTRIES.has(entryName)) return resolvePackageBin(entryName, entryName);
  return null;
}

async function runEntry(entryName: string, entryArguments: readonly string[]): Promise<void> {
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

const [, , subcommand, entryName = '', ...entryArguments] = process.argv;
if (subcommand === BINARY_RUN_SUBCOMMAND) await runEntry(entryName, entryArguments);
if (subcommand !== BINARY_RUN_SUBCOMMAND) await runCli();

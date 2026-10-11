import { parseArguments, usage } from './arguments.ts';
import { intents } from './intents.ts';

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) console.log(usage);
  if (!options.help && options.listIntents) console.table(intents.map((intent) => ({ name: intent.name, expectedEnd: intent.expectedEnd })));
  if (!options.help && !options.listIntents) {
    const { runBatch } = await import('./batch.ts');
    process.exitCode = await runBatch(options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

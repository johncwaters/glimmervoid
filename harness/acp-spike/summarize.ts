import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECORDINGS_DIR = join(import.meta.dirname, 'recordings');
const MAX_TEXT_CHARS = 600;

type JsonObject = Record<string, unknown>;

function shorten(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}[cut]` : value;
  if (Array.isArray(value)) return value.slice(0, 12).map(shorten);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shorten(inner)]));
}

function outcomeLine(outcome: unknown): unknown {
  if (outcome === null || typeof outcome !== 'object') return outcome;
  const { updateKinds, ...rest } = outcome as JsonObject;
  return { ...rest, distinctUpdateKinds: [...new Set((updateKinds ?? []) as string[])] };
}

const wantedAgents = process.argv.slice(2);
for (const agentName of readdirSync(RECORDINGS_DIR)) {
  if (wantedAgents.length > 0 && !wantedAgents.includes(agentName)) continue;
  for (const fileName of readdirSync(join(RECORDINGS_DIR, agentName)).filter((name) => name.endsWith('.summary.json'))) {
    const summaryPath = join(RECORDINGS_DIR, agentName, fileName);
    const { initialize: _initialize, availableCommandNames: _commands, newSession: _newSession, configOptions: _configOptions, ...summary } = JSON.parse(
      readFileSync(summaryPath, 'utf8'),
    ) as JsonObject;
    const condensed: JsonObject = { ...summary };
    for (const key of ['outcome', 'firstTurn', 'secondTurn', 'cancelled', 'after']) {
      if (key in condensed) condensed[key] = outcomeLine(condensed[key]);
    }
    process.stdout.write(`\n### ${agentName} ${fileName}\n${JSON.stringify(shorten(condensed), null, 1)}\n`);
  }
}

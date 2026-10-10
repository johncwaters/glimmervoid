import { readFile } from 'node:fs/promises';

export function readCoherenceFixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/coherence/0.37.1/${name}.json`, import.meta.url), 'utf8');
}

import { parseEnv } from 'node:util';

const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const QUOTE_PREFERENCE = ["'", '`', '"'] as const;

function envLineOrNull(name: string, value: string): string | null {
  for (const quote of QUOTE_PREFERENCE) {
    if (value.includes(quote)) continue;
    const line = `${name}=${quote}${value}${quote}`;
    if (parseEnv(line)[name] === value) return line;
  }
  return null;
}

function unwritableEnvNames(valuesByName: Readonly<Record<string, string>>): string[] {
  return Object.entries(valuesByName).filter(([name, value]) => envLineOrNull(name, value) === null).map(([name]) => name);
}

function upsertEnvLines(existingText: string, valuesByName: Readonly<Record<string, string>>): string {
  const lineByName = new Map<string, string>();
  for (const [name, value] of Object.entries(valuesByName)) {
    const line = envLineOrNull(name, value);
    if (line !== null) lineByName.set(name, line);
  }
  const replacedNames = new Set<string>();
  const lines = existingText === '' ? [] : existingText.replace(/\n$/, '').split('\n');
  const updatedLines = lines.map((line) => {
    const name = ENV_ASSIGNMENT.exec(line)?.[1];
    const replacement = name === undefined ? undefined : lineByName.get(name);
    if (name === undefined || replacement === undefined) return line;
    replacedNames.add(name);
    return replacement;
  });
  const appendedLines = [...lineByName].filter(([name]) => !replacedNames.has(name)).map(([, line]) => line);
  return `${[...updatedLines, ...appendedLines].join('\n')}\n`;
}

export { unwritableEnvNames, upsertEnvLines };

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');

const laneModules = [
  { file: 'server/trace-wiring.ts', prefix: '[trace]' },
  { file: 'server/usage-wiring.ts', prefix: '[usage]' },
  { file: 'server/usage-scanner.ts', prefix: '[usage]' },
  { file: 'server/usage-lane-ledger.ts', prefix: '[usage]' },
  { file: 'server/usage-pricing.ts', prefix: '[usage]' },
];

const calledLoggerChannel = /\blogger\s*\.\s*(?:log|warn|error|info|debug)\s*\(/;
const loggerGuard = /typeof\s+logger\s*\.\s*(?:log|warn)/;
const bracketPrefix = /['"]\s*(\[[a-z][a-z0-9:-]*\])/g;

function sourceFor(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function wiringArgumentObject(source: string, call: string): string {
  const callStart = source.indexOf(call);
  assert.notEqual(callStart, -1, `expected ${call} in server/backend-lanes.ts`);
  const objectStart = callStart + call.length - 1;
  let openBraceDepth = 0;
  for (let index = objectStart; index < source.length; index++) {
    if (source[index] === '{') openBraceDepth++;
    if (source[index] !== '}') continue;
    openBraceDepth--;
    if (openBraceDepth === 0) return source.slice(objectStart, index + 1);
  }
  assert.fail(`expected the ${call} argument object to close`);
}

test('trace and usage lanes use lane-log for their logging boundary', () => {
  const offenders: string[] = [];
  for (const { file, prefix } of laneModules) {
    const source = sourceFor(file);
    if (!source.includes("from './lane-log.ts'")) offenders.push(`${file}: missing import from './lane-log.ts'`);
    if (/console\./.test(source)) offenders.push(`${file}: direct console channel`);
    if (calledLoggerChannel.test(source)) offenders.push(`${file}: called logger channel`);
    if (loggerGuard.test(source)) offenders.push(`${file}: hand-rolled logger guard`);
    for (const match of source.matchAll(bracketPrefix)) {
      if (match[1] !== prefix) offenders.push(`${file}: unexpected bracket prefix ${match[1]}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These lane modules must use createLaneLog exclusively:\n  ${offenders.join('\n  ')}`,
  );
});

test('backend lane wiring forwards logger and debug settings', () => {
  const source = sourceFor('server/backend-lanes.ts');
  for (const call of ['createTraceWiring({', 'createUsageWiring({']) {
    const argumentObject = wiringArgumentObject(source, call);
    assert.match(argumentObject, /\blogger\b/, `${call} must receive logger`);
    assert.match(argumentObject, /\bdebug:/, `${call} must receive debug`);
  }
});

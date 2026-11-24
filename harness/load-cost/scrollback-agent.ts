import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const IDLE_GLYPH = String.fromCharCode(0x2733);
const MAX_FILL_LINES = 20_000;
const WRITE_CHUNK_CAP_CHARS = 64 * 1024;
const TOOL_NAMES = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];

export function fillCompleteMarker(lineCount: number): string {
  return `load-cost fill complete ${lineCount}`;
}

export const PONG = 'load-cost agent ready';

function transcriptLine(index: number): string {
  const tint = 31 + (index % 7);
  const toolName = TOOL_NAMES[index % TOOL_NAMES.length] ?? 'Read';
  const detail = `src/module-${index % 97}/file-${index % 13}.ts`.padEnd(40 + (index % 23), '.');
  return `${ESC}[${tint}m${toolName}${ESC}[0m(${ESC}[1m${detail}${ESC}[22m) ${ESC}[2mline ${index}${ESC}[22m\r\n`;
}

function writeFill(lineCount: number): void {
  let chunk = '';
  for (let index = 0; index < lineCount; index += 1) {
    chunk += transcriptLine(index);
    if (chunk.length < WRITE_CHUNK_CAP_CHARS) continue;
    process.stdout.write(chunk);
    chunk = '';
  }
  process.stdout.write(`${chunk}${fillCompleteMarker(lineCount)}\r\n`);
}

function dispatch(command: string): void {
  if (command === 'ping') {
    process.stdout.write(`${PONG}\r\n`);
    return;
  }
  if (command.startsWith('fill ')) {
    const requested = Number.parseInt(command.slice('fill '.length), 10);
    if (!Number.isInteger(requested) || requested < 1) return;
    writeFill(Math.min(requested, MAX_FILL_LINES));
    return;
  }
  if (command === 'exit') process.exit(0);
}

function settingsPathFromArgv(argv: string[]): string | null {
  const flagIndex = argv.indexOf('--settings');
  if (flagIndex < 0) return null;
  return argv[flagIndex + 1] ?? null;
}

function sessionStartHookCommands(settingsPath: string | null): string[] {
  if (!settingsPath) return [];
  const settings: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const sessionStartGroups: unknown = Reflect.get(Reflect.get(Object(settings), 'hooks') ?? {}, 'SessionStart');
  if (!Array.isArray(sessionStartGroups)) return [];
  return sessionStartGroups
    .flatMap((group: unknown) => {
      const hooks: unknown = Reflect.get(Object(group), 'hooks');
      return Array.isArray(hooks) ? hooks : [];
    })
    .filter((hook: unknown) => Reflect.get(Object(hook), 'type') === 'command' && Reflect.get(Object(hook), 'async') !== true)
    .map((hook: unknown) => Reflect.get(Object(hook), 'command'))
    .filter((command: unknown): command is string => typeof command === 'string');
}

function runSessionStartHooks(): void {
  const hookInput = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: randomUUID(), cwd: process.cwd() });
  for (const command of sessionStartHookCommands(settingsPathFromArgv(process.argv.slice(2)))) {
    const hookProcess = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
    hookProcess.stdin.end(hookInput);
  }
}

let pending = '';

function onInput(chunk: string): void {
  pending += chunk;
  const lines = pending.split(/[\r\n]/);
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const command = line.trim();
    if (command.length > 0) dispatch(command);
  }
}

if (process.argv[1] === import.meta.filename) {
  process.stdout.write(`${ESC}]0;${IDLE_GLYPH} idle${BEL}`);
  runSessionStartHooks();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk: string | Buffer) => { onInput(String(chunk)); });
  process.stdin.on('end', () => { process.exit(0); });
}

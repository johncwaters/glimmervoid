import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createShellHistoryIngest } from '../server/ingest/ingest-shell-history.ts';
import type { ShellHistoryOptions } from '../server/ingest/ingest-shell-history.ts';
import type { ShellIngestEvent } from '../server/ingest/core/ingest-shell-core.ts';

type ShellHistoryIngest = ReturnType<typeof createShellHistoryIngest>;

interface Home {
  tmpDir: string;
  psDir: string;
  fishDir: string;
  env: NodeJS.ProcessEnv;
}

interface HomeContext extends Home {
  events: ShellIngestEvent[];
  warnings: string[];
  build: (overrides?: Partial<ShellHistoryOptions>) => ShellHistoryIngest;
}

function makeHome(): Home {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-shellhist-'));
  const appData = path.join(tmpDir, 'AppData', 'Roaming');
  const psDir = path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine');
  const dataHome = path.join(tmpDir, '.local', 'share');
  const fishDir = path.join(dataHome, 'fish');
  return {
    tmpDir,
    psDir,
    fishDir,
    env: {
      APPDATA: appData,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
    },
  };
}

function parkedTimer(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 2 ** 30);
  handle.unref();
  return handle;
}

function inertTimers(): Partial<ShellHistoryOptions> {
  return {
    setIntervalFn: () => parkedTimer(),
    clearIntervalFn: (handle) => { clearTimeout(handle); },
    setTimeoutFn: () => parkedTimer(),
    clearTimeoutFn: (handle) => { clearTimeout(handle); },
  };
}

function withHome(fn: (context: HomeContext) => Promise<void>): () => Promise<void> {
  return async () => {
    const home = makeHome();
    const events: ShellIngestEvent[] = [];
    const warnings: string[] = [];
    const adapters: ShellHistoryIngest[] = [];
    const build = (overrides: Partial<ShellHistoryOptions> = {}): ShellHistoryIngest => {
      const adapter = createShellHistoryIngest({
        publish: (event) => events.push(event),
        env: home.env,
        platform: 'win32',
        logger: { warn: (message: string) => { warnings.push(message); } },
        ...inertTimers(),
        ...overrides,
      });
      adapters.push(adapter);
      return adapter;
    };
    try {
      await fn({ ...home, events, warnings, build });
    } finally {
      for (const adapter of adapters) adapter.stop();
      fs.rmSync(home.tmpDir, { recursive: true, force: true });
    }
  };
}

function seedPsReadLine(psDir: string, { host = 'ConsoleHost', lines = [] }: { host?: string; lines?: string[] } = {}): string {
  fs.mkdirSync(psDir, { recursive: true });
  const filePath = path.join(psDir, `${host}_history.txt`);
  fs.writeFileSync(filePath, lines.map((line) => `${line}\n`).join(''), 'utf8');
  return filePath;
}

function seedZsh(homeDir: string, { lines = [] }: { lines?: string[] } = {}): string {
  fs.mkdirSync(homeDir, { recursive: true });
  const filePath = path.join(homeDir, '.zsh_history');
  fs.writeFileSync(filePath, lines.map((line) => `${line}\n`).join(''), 'utf8');
  return filePath;
}

function append(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text, 'utf8');
}

function summaries(events: ShellIngestEvent[]): string[] {
  return events.map((event) => event.summary);
}

test('a command accepted after start publishes, and the history before it never does', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm install', 'git push', 'npx vite build'] });

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 1, 'the history file is tailed');
  await adapter.poll();
  assert.equal(events.length, 0, 'commands written before start() must never publish');

  append(filePath, 'npm run deploy\n');
  await adapter.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'shellHistory');
  assert.equal(events[0].kind, 'command');
  assert.equal(events[0].summary, 'powershell: npm run deploy');
  assert.deepEqual(events[0].scope, { root: null, sessionId: null }, 'a history file records no cwd');
}));

test('the dup collapse sees every parsed command, so the drain bound cannot resurrect a repeat', withHome(async ({ psDir, events, build }) => {
  const filePath = seedPsReadLine(psDir, { lines: ['npm test'] });
  const adapter = build();
  await adapter.start();

  const distinct = Array.from({ length: 9 }, (_, index) => `git commit -m fix-${index}`);
  const repeated = Array.from({ length: 51 }, () => 'npm run watch');
  append(filePath, [...distinct, ...repeated].map((line) => `${line}\n`).join(''));
  await adapter.poll();

  const published = summaries(events);
  assert.equal(published.length, 10, `nine real commands plus one watch: ${published.join(' | ')}`);
  assert.equal(published.filter((line) => line.endsWith('npm run watch')).length, 1);
  for (const command of distinct) {
    assert.ok(published.includes(`powershell: ${command}`), `${command} was dropped by the bound`);
  }
  assert.ok(!published.some((line) => line.includes('earlier commands dropped')), 'nothing publishable was dropped');
}));

test('on macOS the unconfigured default tails the zsh history, extended-history stamps and all', withHome(async ({ tmpDir, events, warnings, build }) => {
  const filePath = seedZsh(tmpDir, { lines: [': 1700000000:0;npm install'] });
  const adapter = build({ platform: 'darwin' });
  await adapter.start();

  assert.deepEqual(adapter.trackedFiles, [filePath], 'a mac with no shells config still reads its own history');
  append(filePath, ': 1700000005:0;npm run deploy\n');
  await adapter.poll();

  assert.deepEqual(summaries(events), ['zsh: npm run deploy']);
  assert.equal(events[0].ts, 1700000005000, 'the extended-history stamp survives the IO shell');
  assert.deepEqual(warnings, []);
}));

test('on macOS a PowerShell history sitting in the home directory is NOT tailed by default', withHome(async ({ psDir, tmpDir, build }) => {
  seedPsReadLine(psDir, { lines: ['npm test'] });
  seedZsh(tmpDir, { lines: [': 1700000000:0;npm install'] });
  const adapter = build({ platform: 'darwin' });
  await adapter.start();

  assert.equal(adapter.trackedCount, 1, 'only the zsh history, never the PSReadLine file beside it');
}));

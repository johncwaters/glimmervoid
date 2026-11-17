import '../support/disable-telemetry.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { TraceRecord } from '../../shared/contracts/trace.ts';
import { browserTypeOf } from '../support/browser-engines.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const PAGE_ROOT = path.join(import.meta.dirname, 'chat-view');
const USAGE = 'usage: node harness/browser/chat-view.ts <trace.jsonl> [--from <record index>] [--count <records>] [--port <port>] [--cwd <session cwd>] [--cards] [--live] [--screenshot <out.png>] [--executable <chrome path>]';

interface ChatViewOptions {
  tracePath: string;
  firstRecordIndex: number;
  recordCount: number;
  port: number;
  sessionCwd: string | null;
  showsExampleCards: boolean;
  playsLive: boolean;
  screenshotPath: string | null;
  executablePath: string | null;
}

function optionValue(argumentList: readonly string[], flag: string): string | null {
  const flagIndex = argumentList.indexOf(flag);
  return flagIndex === -1 ? null : argumentList[flagIndex + 1] ?? null;
}

function parseOptions(argumentList: readonly string[]): ChatViewOptions | null {
  const tracePath = argumentList[0];
  if (!tracePath || tracePath.startsWith('--')) return null;
  const screenshotPath = optionValue(argumentList, '--screenshot');
  const executablePath = optionValue(argumentList, '--executable');
  return {
    tracePath: path.resolve(tracePath),
    firstRecordIndex: Number(optionValue(argumentList, '--from') ?? '0'),
    recordCount: Number(optionValue(argumentList, '--count') ?? '200'),
    port: Number(optionValue(argumentList, '--port') ?? '5199'),
    sessionCwd: optionValue(argumentList, '--cwd'),
    showsExampleCards: argumentList.includes('--cards'),
    playsLive: argumentList.includes('--live'),
    screenshotPath: screenshotPath === null ? null : path.resolve(screenshotPath),
    executablePath: executablePath === null ? null : path.resolve(executablePath),
  };
}

function traceRecordOfLine(line: string): TraceRecord | null {
  try {
    const parsedRecord = TraceRecord.safeParse(JSON.parse(line));
    return parsedRecord.success ? parsedRecord.data : null;
  } catch {
    return null;
  }
}

function conversationRecordsOf(options: ChatViewOptions): TraceRecord[] {
  const parsedRecords = fs.readFileSync(options.tracePath, 'utf8').split('\n')
    .filter((line) => line.trim().length > 0)
    .map(traceRecordOfLine)
    .filter((record): record is TraceRecord => record !== null && record.kind !== 'raw');
  return parsedRecords.slice(options.firstRecordIndex, options.firstRecordIndex + options.recordCount);
}

function traceRecordsPlugin(traceRecords: readonly TraceRecord[], sessionCwd: string | null): Plugin {
  return {
    name: 'chat-view-trace-records',
    configureServer(server) {
      server.middlewares.use('/trace-records.json', (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ records: traceRecords, pathContext: { cwd: sessionCwd, home: os.homedir() } }));
      });
    },
  };
}

async function captureScreenshot(url: string, screenshotPath: string, executablePath: string | null): Promise<void> {
  const chromium = await browserTypeOf('chromium');
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(url);
  await page.waitForSelector('body[data-rendered="true"]');
  await page.screenshot({ path: screenshotPath });
  await browser.close();
  if (pageErrors.length > 0) throw new Error(`the chat view threw: ${pageErrors.join('; ')}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    process.exit(2);
  }
  const { createServer } = await import('vite');
  const tailwindcss = (await import('@tailwindcss/vite')).default;
  const server = await createServer({
    configFile: false,
    root: PAGE_ROOT,
    publicDir: false,
    plugins: [tailwindcss(), traceRecordsPlugin(conversationRecordsOf(options), options.sessionCwd)],
    server: { port: options.port, strictPort: true, fs: { allow: [REPO_ROOT] } },
    logLevel: 'warn',
    clearScreen: false,
  });
  await server.listen();
  const query = [options.showsExampleCards ? 'cards' : '', options.playsLive ? 'live' : ''].filter((flag) => flag.length > 0).join('&');
  const url = `http://localhost:${options.port}/${query ? `?${query}` : ''}`;
  if (options.screenshotPath === null) {
    console.log(`chat view of ${options.tracePath} at ${url}`);
    return;
  }
  await captureScreenshot(url, options.screenshotPath, options.executablePath).finally(() => server.close());
  console.log(`wrote ${options.screenshotPath}`);
}

await main();

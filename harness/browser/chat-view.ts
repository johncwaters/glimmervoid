import '../support/disable-telemetry.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { Plugin } from 'vite';
import { TraceRecord } from '../../shared/contracts/trace.ts';
import { browserTypeOf } from '../support/browser-engines.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const PAGE_ROOT = path.join(import.meta.dirname, 'chat-view');
const USAGE = 'usage: node harness/browser/chat-view.ts <trace.jsonl> [--from <record index>] [--count <records>] [--port <port>] [--cards] [--live] [--working] [--earlier] [--screenshot <out.png>] [--executable <chrome path>]';

interface ChatViewOptions {
  tracePath: string;
  firstRecordIndex: number;
  recordCount: number;
  port: number;
  showsExampleCards: boolean;
  playsLive: boolean;
  staysWorking: boolean;
  checksEarlier: boolean;
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
    showsExampleCards: argumentList.includes('--cards'),
    playsLive: argumentList.includes('--live'),
    staysWorking: argumentList.includes('--working'),
    checksEarlier: argumentList.includes('--earlier'),
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

function traceRecordsPlugin(traceRecords: readonly TraceRecord[]): Plugin {
  return {
    name: 'chat-view-trace-records',
    configureServer(server) {
      server.middlewares.use('/trace-records.json', (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ records: traceRecords }));
      });
    },
  };
}

async function checkTurnKeys(page: Page): Promise<string> {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.evaluate(() => window.dispatchEvent(new Event('harness-remount-chat')));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  const isScrolled = await page.evaluate(() => {
    const scroller = document.querySelector('.chat-scroller');
    return scroller !== null && scroller.scrollHeight > scroller.clientHeight;
  });
  if (!isScrolled) throw new Error('the turn keys check needs a Chat taller than its viewport');
  const turnCount = await page.locator('.chat-turn').count();
  if (turnCount < 3) return 'turn keys: not checked, fewer than 3 turns';
  for (const key of ['[', '[', '[']) await page.keyboard.press(key);
  const focusedTurnIndex = await page.evaluate(() => [...document.querySelectorAll('.chat-turn')].indexOf(document.activeElement as Element));
  if (focusedTurnIndex !== turnCount - 3) throw new Error(`[ three times focused turn ${focusedTurnIndex}, not ${turnCount - 3}`);
  const turnTopsBefore = await page.locator('.chat-turn').evaluateAll((turns) => turns.map((turn) => turn.getBoundingClientRect().top));
  const isOpenNow = () => page.evaluate(() => document.activeElement?.hasAttribute('data-open') ?? false);
  const wasOpen = await isOpenNow();
  await page.keyboard.press('Space');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const isOpen = await isOpenNow();
  if (isOpen === wasOpen) throw new Error('Space did not flip the focused turn');
  const turnTopsAfter = await page.locator('.chat-turn').evaluateAll((turns) => turns.map((turn) => turn.getBoundingClientRect().top));
  const movedAboveCount = turnTopsBefore.slice(0, focusedTurnIndex + 1).filter((top, index) => Math.abs(top - (turnTopsAfter[index] ?? top)) > 0.5).length;
  if (movedAboveCount > 0) throw new Error(`opening a turn moved ${movedAboveCount} turns at or above it`);
  await page.keyboard.press('Space');
  if ((await isOpenNow()) !== wasOpen) throw new Error('a second Space did not flip the focused turn back');
  await page.keyboard.press('b');
  const isBriefOff = await page.evaluate(() => document.documentElement.hasAttribute('data-chat-brief-off'));
  await page.keyboard.press('b');
  const isBriefBack = await page.evaluate(() => !document.documentElement.hasAttribute('data-chat-brief-off'));
  if (!isBriefOff || !isBriefBack) throw new Error('B did not switch Brief off and back on');
  return `turn keys on a remounted, scrolled Chat: [ stepped to turn ${focusedTurnIndex}, Space ${wasOpen ? 'closed' : 'opened'} it with 0 turns above moving and flipped it back, B switched Brief off and on`;
}

async function checkEarlierFills(url: string, executablePath: string | null): Promise<string> {
  const chromium = await browserTypeOf('chromium');
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}earlier`);
  const isFilled = await page.waitForFunction(() => {
    const scroller = document.querySelector('.chat-scroller');
    return scroller !== null && scroller.scrollHeight > scroller.clientHeight;
  }, null, { timeout: 10000 }).then(() => true, () => false);
  const shownPartCount = await page.locator('[data-part-id]').count();
  const earliestRecord = await page.evaluate(() => document.body.dataset.earliestOffset ?? 'none');
  await browser.close();
  if (!isFilled) throw new Error(`earlier history stopped loading with ${shownPartCount} parts shown, earliest record ${earliestRecord}`);
  return `earlier history filled the Chat: ${shownPartCount} parts shown, earliest record ${earliestRecord}`;
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
  const turnEndShiftPx = await page.evaluate(() => document.body.dataset.turnEndShiftPx ?? null);
  const turnMetaRows = await page.locator('.chat-turn[data-foldable] .chat-turn-meta').allInnerTexts();
  const turnKeysReport = await checkTurnKeys(page);
  await browser.close();
  if (pageErrors.length > 0) throw new Error(`the chat view threw: ${pageErrors.join('; ')}`);
  if (turnEndShiftPx !== null && turnEndShiftPx !== '0') throw new Error(`ending the turn moved the conversation by ${turnEndShiftPx}px`);
  console.log(`turn end shift: ${turnEndShiftPx === null ? 'not measured' : `${turnEndShiftPx}px`}; turn meta rows: ${JSON.stringify(turnMetaRows)}; ${turnKeysReport}`);
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
    plugins: [tailwindcss(), traceRecordsPlugin(conversationRecordsOf(options))],
    server: { port: options.port, strictPort: true, fs: { allow: [REPO_ROOT] } },
    logLevel: 'warn',
    clearScreen: false,
  });
  await server.listen();
  const query = [options.showsExampleCards ? 'cards' : '', options.playsLive ? 'live' : '', options.staysWorking ? 'working' : ''].filter((flag) => flag.length > 0).join('&');
  const url = `http://localhost:${options.port}/${query ? `?${query}` : ''}`;
  if (options.checksEarlier) {
    const earlierReport = await checkEarlierFills(url, options.executablePath).finally(() => server.close());
    console.log(earlierReport);
    return;
  }
  if (options.screenshotPath === null) {
    console.log(`chat view of ${options.tracePath} at ${url}`);
    return;
  }
  await captureScreenshot(url, options.screenshotPath, options.executablePath).finally(() => server.close());
  console.log(`wrote ${options.screenshotPath}`);
}

await main();

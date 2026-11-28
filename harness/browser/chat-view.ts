import '../support/disable-telemetry.ts';
import '../support/git-local-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { Plugin } from 'vite';
import { TraceRecord } from '../../shared/contracts/trace.ts';
import { browserTypeOf } from '../support/browser-engines.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const PAGE_ROOT = path.join(import.meta.dirname, 'chat-view');
const USAGE = 'usage: node harness/browser/chat-view.ts <trace.jsonl> [--from <record index>] [--count <records>] [--port <port>] [--cards] [--live] [--working] [--earlier] [--moved] [--links] [--fingerprint <out.json>] [--fingerprint-compare <baseline.json>] [--perf <runs>] [--screenshot <out.png>] [--executable <chrome path>]';

interface ChatViewOptions {
  tracePath: string;
  firstRecordIndex: number;
  recordCount: number;
  port: number;
  showsExampleCards: boolean;
  playsLive: boolean;
  staysWorking: boolean;
  checksEarlier: boolean;
  checksMoved: boolean;
  checksLinks: boolean;
  fingerprintPath: string | null;
  fingerprintComparePath: string | null;
  perfRuns: number | null;
  screenshotPath: string | null;
  executablePath: string | null;
}

interface ChatFingerprint {
  rest: string[];
  opened: string[];
  live: string[];
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
  const fingerprintPath = optionValue(argumentList, '--fingerprint');
  const fingerprintComparePath = optionValue(argumentList, '--fingerprint-compare');
  const perfValue = optionValue(argumentList, '--perf');
  const perfRuns = perfValue === null ? null : Number(perfValue);
  if (perfRuns !== null && (!Number.isInteger(perfRuns) || perfRuns < 1)) return null;
  return {
    tracePath: path.resolve(tracePath),
    firstRecordIndex: Number(optionValue(argumentList, '--from') ?? '0'),
    recordCount: Number(optionValue(argumentList, '--count') ?? '200'),
    port: Number(optionValue(argumentList, '--port') ?? '5199'),
    showsExampleCards: argumentList.includes('--cards'),
    playsLive: argumentList.includes('--live'),
    staysWorking: argumentList.includes('--working'),
    checksEarlier: argumentList.includes('--earlier'),
    checksMoved: argumentList.includes('--moved'),
    checksLinks: argumentList.includes('--links'),
    fingerprintPath: fingerprintPath === null ? null : path.resolve(fingerprintPath),
    fingerprintComparePath: fingerprintComparePath === null ? null : path.resolve(fingerprintComparePath),
    perfRuns,
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
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: EARLIER_VIEWPORT_HEIGHT_PX } });
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}earlier&reply=0`);
    const isFilled = await page.waitForFunction(() => {
      const scroller = document.querySelector('.chat-scroller');
      return scroller !== null && scroller.scrollHeight > scroller.clientHeight;
    }, null, { timeout: 10000 }).then(() => true, () => false);
    await page.waitForTimeout(EARLIER_SETTLE_MS);
    const shownPartCount = await page.locator('[data-part-id]').count();
    const earliestRecord = await page.evaluate(() => document.body.dataset.earliestOffset ?? 'none');
    if (!isFilled) throw new Error(`earlier history stopped loading with ${shownPartCount} parts shown, earliest record ${earliestRecord}`);
    const opened = await readScrollPlace(page);
    if (opened.distanceFromBottomPx > 1 || opened.isJumpShown) throw new Error(`earlier history pulled the Chat ${opened.distanceFromBottomPx}px above the latest message, Jump to latest ${opened.isJumpShown ? 'shown' : 'hidden'}`);
    return `earlier history filled the Chat at the latest message: ${shownPartCount} parts shown, earliest record ${earliestRecord}`;
  } finally {
    await browser.close();
  }
}

const EARLIER_SETTLE_MS = 1000;
const EARLIER_VIEWPORT_HEIGHT_PX = 300;

interface ChatScrollPlace {
  scrollTopPx: number;
  distanceFromBottomPx: number;
  isJumpShown: boolean;
}

const MOVE_SETTLE_MS = 300;
const SCROLLED_UP_PX = 300;

async function readScrollPlace(page: Page): Promise<ChatScrollPlace> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.chat-scroller');
    const jumpButton = document.querySelector('.chat-jump-slot button');
    if (!(scroller instanceof HTMLElement) || !(jumpButton instanceof HTMLButtonElement)) throw new Error('the Chat has no scroller or Jump to latest button');
    return { scrollTopPx: Math.round(scroller.scrollTop), distanceFromBottomPx: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop), isJumpShown: !jumpButton.hidden };
  });
}

async function moveChatWithinOneTask(page: Page): Promise<ChatScrollPlace> {
  await page.evaluate(() => {
    const chatElement = document.querySelector('.chat-view');
    const parent = chatElement?.parentElement;
    if (!chatElement || !parent) throw new Error('the Chat is not mounted');
    const newParent = document.createElement('div');
    newParent.style.display = 'contents';
    parent.append(newParent);
    newParent.append(chatElement);
  });
  await page.waitForTimeout(MOVE_SETTLE_MS);
  return readScrollPlace(page);
}

async function checkMovedChatKeepsPlace(url: string, executablePath: string | null): Promise<string> {
  const chromium = await browserTypeOf('chromium');
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(url);
    await page.waitForSelector('body[data-rendered="true"]');
    await page.waitForTimeout(MOVE_SETTLE_MS);
    const atRest = await readScrollPlace(page);
    if (atRest.scrollTopPx === 0 || atRest.distanceFromBottomPx > 1) throw new Error(`the Chat did not overflow at the latest message before the move: ${JSON.stringify(atRest)}`);
    const followingAfterMove = await moveChatWithinOneTask(page);
    if (followingAfterMove.distanceFromBottomPx > 1) throw new Error(`moving a following Chat left it ${followingAfterMove.distanceFromBottomPx}px above the latest message`);
    await page.evaluate((scrolledUpPx) => {
      const scroller = document.querySelector('.chat-scroller');
      if (scroller instanceof HTMLElement) scroller.scrollTop -= scrolledUpPx;
    }, SCROLLED_UP_PX);
    await page.waitForTimeout(MOVE_SETTLE_MS);
    const scrolledUp = await readScrollPlace(page);
    if (!scrolledUp.isJumpShown) throw new Error(`the trace is too short to scroll the Chat up away from the latest message: ${JSON.stringify(scrolledUp)}`);
    const scrolledUpAfterMove = await moveChatWithinOneTask(page);
    if (scrolledUpAfterMove.scrollTopPx !== scrolledUp.scrollTopPx || !scrolledUpAfterMove.isJumpShown) throw new Error(`moving a scrolled up Chat lost its place: before ${JSON.stringify(scrolledUp)}, after ${JSON.stringify(scrolledUpAfterMove)}`);
    return `a moved Chat kept its place: following stayed at the latest message, scrolled up stayed at ${scrolledUp.scrollTopPx}px with Jump to latest shown`;
  } finally {
    await browser.close();
  }
}

const LINK_POPUP_TIMEOUT_MS = 2000;

type ChatLinkPopupReading = { isVisible: boolean; host: string; mismatch: string; hasCopyLink: boolean; topPx: number; overlapsDockPx: number };

async function readChatLinkPopup(page: Page): Promise<ChatLinkPopupReading> {
  return page.evaluate(() => {
    const popup = document.querySelector('.chat-view .terminal-link-popup');
    if (!(popup instanceof HTMLElement)) return { isVisible: false, host: '', mismatch: '', hasCopyLink: false, topPx: 0, overlapsDockPx: 0 };
    const popupBox = popup.getBoundingClientRect();
    return {
      isVisible: !popup.hidden && popupBox.height > 0,
      host: popup.querySelector('.terminal-link-popup-host')?.textContent ?? '',
      mismatch: popup.querySelector('.terminal-link-popup-mismatch')?.textContent ?? '',
      hasCopyLink: [...popup.querySelectorAll('button')].some((control) => control.textContent === 'Copy link'),
      topPx: popupBox.top,
      overlapsDockPx: Math.max(0, popupBox.bottom - (document.querySelector('.chat-dock')?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY)),
    };
  });
}

async function waitForChatLinkPopup(page: Page, label: string, isWanted: (reading: ChatLinkPopupReading) => boolean): Promise<ChatLinkPopupReading> {
  const deadline = Date.now() + LINK_POPUP_TIMEOUT_MS;
  let reading = await readChatLinkPopup(page);
  while (!isWanted(reading)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(reading)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    reading = await readChatLinkPopup(page);
  }
  return reading;
}

async function checkChatLinkPopup(url: string, executablePath: string | null): Promise<string> {
  const chromium = await browserTypeOf('chromium');
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  try {
    await page.goto(url);
    await page.waitForSelector('a.plan-link');
    const links = page.locator('.chat-view a.plan-link');
    await page.waitForSelector('body[data-rendered="true"]');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const plainLinkBox = await links.nth(0).boundingBox();
    if (!plainLinkBox) throw new Error('the bare link has no box');
    await page.mouse.move(plainLinkBox.x + 4, plainLinkBox.y + plainLinkBox.height / 2);
    const shown = await waitForChatLinkPopup(page, 'hovering a bare chat link shows its host', (reading) => reading.isVisible && reading.host === 'example.com');
    if (shown.mismatch !== '') throw new Error(`a bare link showed a mismatch: ${shown.mismatch}`);
    if (!shown.hasCopyLink) throw new Error('the chat link popup has no Copy link control');
    if (shown.topPx < plainLinkBox.y + plainLinkBox.height - 1) throw new Error(`the popup top ${shown.topPx} covers the link ending at ${plainLinkBox.y + plainLinkBox.height}`);
    await page.mouse.move(plainLinkBox.x + 4, shown.topPx + 8);
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!(await readChatLinkPopup(page)).isVisible) throw new Error('the popup closed while the pointer rested on it');
    await page.keyboard.press('Escape');
    await waitForChatLinkPopup(page, 'Esc closes the chat link popup', (reading) => !reading.isVisible);
    await page.mouse.move(plainLinkBox.x + 4, plainLinkBox.y + plainLinkBox.height / 2);
    await waitForChatLinkPopup(page, 'returning to the link shows the popup again', (reading) => reading.isVisible);
    await page.evaluate(() => document.querySelector('.chat-scroller')?.dispatchEvent(new Event('scroll')));
    await waitForChatLinkPopup(page, 'scrolling the chat closes the popup', (reading) => !reading.isVisible);
    await page.mouse.move(plainLinkBox.x + 12, plainLinkBox.y + plainLinkBox.height / 2);
    await waitForChatLinkPopup(page, 'moving on the same link after a scroll shows the popup again', (reading) => reading.isVisible);
    await page.mouse.move(2, 2);
    await waitForChatLinkPopup(page, 'leaving the bare link closes the popup', (reading) => !reading.isVisible);
    const deceptiveLinkBox = await links.nth(1).boundingBox();
    if (!deceptiveLinkBox) throw new Error('the markdown link has no box');
    await page.mouse.move(deceptiveLinkBox.x + 4, deceptiveLinkBox.y + deceptiveLinkBox.height / 2);
    const warned = await waitForChatLinkPopup(page, 'a markdown link naming another host shows the mismatch', (reading) => reading.isVisible && reading.mismatch.includes('github.com') && reading.mismatch.includes('login.example.net'));
    if (shown.overlapsDockPx > 0 || warned.overlapsDockPx > 0) throw new Error(`the popup covers the message box by ${Math.max(shown.overlapsDockPx, warned.overlapsDockPx)}px`);
    await page.mouse.move(2, 2);
    await waitForChatLinkPopup(page, 'leaving the link closes the popup', (reading) => !reading.isVisible);
    if (pageErrors.length > 0) throw new Error(`the chat view threw: ${pageErrors.join('; ')}`);
    return `chat link popup: bare link shows host ${shown.host} below the link with Copy link, stays under the pointer, Esc and a chat scroll close it and it shows again on the same link; markdown link warns ${JSON.stringify(warned.mismatch)}; leaving closes it`;
  } finally {
    await browser.close();
  }
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

async function readFingerprint(page: Page): Promise<string[]> {
  return page.evaluate(() => (Reflect.get(window, 'chatFingerprint') as () => string[])());
}

async function captureFingerprint(baseUrl: string, executablePath: string | null): Promise<ChatFingerprint> {
  const chromium = await browserTypeOf('chromium');
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${baseUrl}?cards`);
    await page.waitForSelector('body[data-rendered="true"]');
    const rest = await readFingerprint(page);
    await page.evaluate(() => {
      for (const meta of document.querySelectorAll<HTMLElement>('.chat-turn[data-foldable] .chat-turn-meta')) meta.click();
      for (const row of document.querySelectorAll<HTMLElement>('.chat-subagent-row')) row.click();
    });
    const opened = await readFingerprint(page);
    await page.goto(`${baseUrl}?live`);
    await page.waitForSelector('body[data-live-done="true"]');
    const live = await readFingerprint(page);
    if (pageErrors.length > 0) throw new Error(`the chat view threw: ${pageErrors.join('; ')}`);
    return { rest, opened, live };
  } finally {
    await browser.close();
  }
}

function firstDifferenceOf(section: keyof ChatFingerprint, expected: readonly string[], actual: readonly string[]): string | null {
  const maxLength = Math.max(expected.length, actual.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (expected[index] === actual[index]) continue;
    return `${section}[${index}] expected ${JSON.stringify(expected[index] ?? '<eof>')} got ${JSON.stringify(actual[index] ?? '<eof>')}`;
  }
  return null;
}

function compareFingerprints(expected: ChatFingerprint, actual: ChatFingerprint): string[] {
  const sections: (keyof ChatFingerprint)[] = ['rest', 'opened', 'live'];
  return sections.flatMap((section) => {
    const difference = firstDifferenceOf(section, expected[section], actual[section]);
    return difference === null ? [] : [difference];
  });
}

async function measurePerf(baseUrl: string, runs: number, executablePath: string | null): Promise<string> {
  const chromium = await browserTypeOf('chromium');
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${baseUrl}?perf=${runs}`);
    await page.waitForSelector('body[data-perf]');
    const perfJson = await page.evaluate(() => document.body.dataset.perf ?? '{}');
    if (pageErrors.length > 0) throw new Error(`the chat view threw: ${pageErrors.join('; ')}`);
    return perfJson;
  } finally {
    await browser.close();
  }
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
  const baseUrl = `http://localhost:${options.port}/`;
  const query = [options.showsExampleCards ? 'cards' : '', options.playsLive ? 'live' : '', options.staysWorking ? 'working' : ''].filter((flag) => flag.length > 0).join('&');
  const url = `${baseUrl}${query ? `?${query}` : ''}`;
  if (options.fingerprintPath !== null || options.fingerprintComparePath !== null) {
    const captured = await captureFingerprint(baseUrl, options.executablePath).finally(() => server.close());
    if (options.fingerprintPath !== null) {
      fs.writeFileSync(options.fingerprintPath, `${JSON.stringify(captured, null, 2)}\n`);
      console.log(`wrote ${options.fingerprintPath} (rest ${captured.rest.length}, opened ${captured.opened.length}, live ${captured.live.length} lines)`);
    }
    if (options.fingerprintComparePath !== null) {
      const baseline: ChatFingerprint = JSON.parse(fs.readFileSync(options.fingerprintComparePath, 'utf8'));
      const differences = compareFingerprints(baseline, captured);
      if (differences.length > 0) {
        console.error(differences.join('\n'));
        process.exit(1);
      }
      console.log(`fingerprint matched ${options.fingerprintComparePath} (rest ${captured.rest.length}, opened ${captured.opened.length}, live ${captured.live.length} lines)`);
    }
    return;
  }
  if (options.perfRuns !== null) {
    const perfJson = await measurePerf(baseUrl, options.perfRuns, options.executablePath).finally(() => server.close());
    console.log(perfJson);
    return;
  }
  if (options.checksLinks) {
    console.log(await checkChatLinkPopup(url, options.executablePath).finally(() => server.close()));
    return;
  }
  if (options.checksMoved) {
    console.log(await checkMovedChatKeepsPlace(url, options.executablePath).finally(() => server.close()));
    return;
  }
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

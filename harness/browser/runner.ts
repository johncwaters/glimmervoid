import fs from 'node:fs';
import path from 'node:path';

import type { Browser, BrowserContext, ConsoleMessage, Page, WebSocketRoute } from 'playwright-core';

import { safeTextTail } from '../support/backend-harness.ts';
import { heightWithKeyboardUp, layoutFor, needsSocketRoute } from './cases-core.ts';
import type { HarnessCase, Layout, ResolvedStep, Step, ViewerId, Viewport } from './cases-core.ts';
import { DECEPTIVE_LINK_ROW_NUMBER, DECEPTIVE_LINK_TEXT, DECEPTIVE_LINK_URL, LINK_ROW_LINK_TEXT, LINK_ROW_NUMBER, LINK_ROW_PLAIN_TEXT, MOTION_REPORT_PREFIX, expectedRows, parseStatusRow } from './frame-core.ts';
import { verifyBoardPane, verifyRailDrag, verifyBoardScale, verifyBoards } from './boards.ts';
import { verifyIssues } from './issues.ts';
import { verifyPhoneChanges, verifyReviewMerge } from './review-merge.ts';
import { verifyTeamReviewRows } from './team-review.ts';
import { CARD_REGISTRY_URL, boardRowIds, sessionCardIds, dispatchWindowBlur, dropDataSocket, holdConfirmedSessionRemovals, pillIds, readDocumentEngagement, readGrid, readLayout, readSettingsHistory, readTerminalFocus, readTerminalWatch, scrollTerminalToTop, setDocumentEngagement, setFitMeasurement, watchTerminal } from './probe.ts';
import type { GridReading } from './probe.ts';
import { caseKey } from './report-core.ts';
import type { CaseRecord, GridSnapshot, Outcome, StepRecord } from './report-core.ts';

export interface Deadlines {
  pageReadyMs: number;
  settleMs: number;
  reattachMs: number;
  stepMs: number;
  pollIntervalMs: number;
}

export interface ArtifactPaths {
  shotsDir: string;
  diffsDir: string;
  logsDir: string;
}

export interface RunCaseOptions {
  browser: Browser;
  harnessCase: HarnessCase;
  sessionId: string;
  projectDirectory: string;
  baseUrl: string;
  artifacts: ArtifactPaths;
  deadlines: Deadlines;
}

export const DEFAULT_DEADLINES: Deadlines = {
  pageReadyMs: 10000,
  settleMs: 15000,
  reattachMs: 40000,
  stepMs: 15000,
  pollIntervalMs: 50,
};

export const COLD_START_PAGE_READY_MS = 60000;

const CONSOLE_TAIL_LIMIT = 200;
const GRID_SETTLE_HOLD_MS = 600;
const WEB_SOCKET_OPEN = 1;
const PHONE_CARD_SLOT = '.phone-card-slot';
const DESKTOP_CARD_SLOT = '#focus-pane-terminal';
const DESKTOP_LEAVE_FOCUS_SELECTOR = '#tab-settings';
const DESKTOP_ENTER_FOCUS_SELECTOR = '#tab-focus';
const PHONE_BACK_SELECTOR = 'button[data-action="back-to-board"]';
const PHONE_TERMINAL_MENU_SELECTOR = '.phone-screen[data-screen="terminal"] button[data-action="session-menu"]';
const PHONE_TERMINAL_REMOVE_SELECTOR = '.phone-screen[data-screen="terminal"] button.overflow-remove';
const CONFIRM_DIALOG_SELECTOR = 'button[data-action="confirm-dialog"]:visible';
const PHONE_REMOVE_RETURN_MS = 4000;
const PHONE_MORE_SELECTOR = 'button.phone-nav-item[aria-expanded]';
const PHONE_SETTINGS_MENU_SELECTOR = 'button.phone-nav-menu-item[data-screen="settings"]';
const SETTINGS_SECTION_SELECTOR = 'button.settings-view-nav-item';
interface RememberedGrid {
  cols: number;
  rows: number;
}

interface RowMismatch {
  index: number;
  expected: string;
  actual: string;
}

interface ProbeResult {
  ok: boolean;
  detail: string;
  reading?: GridReading | null;
  mismatch?: RowMismatch | null;
  tick?: number | null;
  isDrawingDeferred?: boolean;
}

interface PollResult {
  ok: boolean;
  detail: string;
  last: ProbeResult | null;
}

interface Viewer {
  id: ViewerId;
  viewport: Viewport;
  layout: Layout;
  context: BrowserContext;
  page: Page;
  width: number;
  height: number;
  restoreHeight: number;
  silenceOpenSockets: () => number;
}

interface RoutedSocket {
  isSilenced: boolean;
}

interface CaseLog {
  lines: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

interface StepOutcome {
  ok: boolean;
  predicate: string;
  detail: string;
  grid: GridSnapshot | null;
  shot: string | null;
  mismatch: RowMismatch | null;
  diffPath: string | null;
}

function pushBoundedLine(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > CONSOLE_TAIL_LIMIT) lines.shift();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function pollUntil(
  probe: () => Promise<ProbeResult>,
  { label, timeoutMs, intervalMs }: { label: string; timeoutMs: number; intervalMs: number },
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult | null = null;
  while (true) {
    last = await probe();
    if (last.ok) return { ok: true, detail: last.detail, last };
    if (Date.now() >= deadline) {
      return { ok: false, detail: `${label} timed out after ${timeoutMs}ms: ${last.detail}`, last };
    }
    await sleep(intervalMs);
  }
}

function firstMismatch(expected: readonly string[], actual: readonly string[]): RowMismatch | null {
  const rowCount = Math.max(expected.length, actual.length);
  for (let index = 0; index < rowCount; index += 1) {
    const expectedRow = expected[index] ?? '';
    const actualRow = actual[index] ?? '';
    if (expectedRow === actualRow) continue;
    return { index, expected: expectedRow, actual: actualRow };
  }
  return null;
}

function snapshotOf(reading: GridReading, tick: number | null): GridSnapshot {
  return {
    cols: reading.cols,
    rows: reading.rows,
    tick,
    dataGrid: reading.dataGrid,
    bufferLength: reading.bufferLength,
  };
}

function describeStep(step: Step): string {
  if (step.kind === 'resize') return `resize ${step.width}x${step.height}`;
  if (step.kind === 'keyboard') return `keyboard ${step.state}`;
  if (step.kind === 'type') return `type ${step.text}`;
  if (step.kind === 'burst') return `burst ${step.lines}`;
  if (step.kind === 'settle') {
    const at = step.expectRemembered === undefined ? '' : ` at ${step.expectRemembered}`;
    return `settle ${step.expectGrid ?? 'exact'}${at}`;
  }
  if (step.kind === 'remember') return `remember ${step.label}`;
  if (step.kind === 'background') return step.quiet === true ? 'background quiet' : 'background';
  if (step.kind === 'foreground') return step.quiet === true ? 'foreground quiet' : 'foreground';
  if (step.kind === 'wait') return `wait ${step.durationMs}ms`;
  if (step.kind === 'assert-grid') return `assert-grid tick+${step.tickOffset ?? 0}`;
  if (step.kind === 'expect-link') return `expect-link ${step.value}`;
  if (step.kind === 'expect-terminal-untouched') return `expect-terminal-untouched ${step.durationMs}ms`;
  if (step.kind === 'shot') return `shot ${step.name}`;
  if (step.kind === 'expect-session-name') return `expect-session-name ${step.name}`;
  return step.kind;
}

function sourceOf(step: Step): string {
  return `${step.viewer ?? 'a'} ${describeStep(step)}`;
}

function passedOutcome(predicate: string, detail: string): StepOutcome {
  return { ok: true, predicate, detail, grid: null, shot: null, mismatch: null, diffPath: null };
}

function failedOutcome(predicate: string, detail: string, mismatch: RowMismatch | null = null): StepOutcome {
  return { ok: false, predicate, detail, grid: null, shot: null, mismatch, diffPath: null };
}

function outcomeFor(predicate: string, poll: PollResult): StepOutcome {
  if (!poll.ok) return failedOutcome(predicate, poll.detail);
  return passedOutcome(predicate, poll.detail);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function readGridOf(viewer: Viewer, sessionId: string): Promise<GridReading | null> {
  return viewer.page.evaluate(readGrid, { sessionId, registryUrl: CARD_REGISTRY_URL });
}

function cardSlotSelector(viewer: Viewer): string {
  if (viewer.layout === 'phone') return PHONE_CARD_SLOT;
  return DESKTOP_CARD_SLOT;
}

function rosterSelector(viewer: Viewer, sessionId: string): string {
  if (viewer.layout === 'phone') return `.phone-board-list button.session-row[data-id="${sessionId}"]`;
  return `.focus-rail button.session-row[data-id="${sessionId}"]`;
}

function listedIds(viewer: Viewer): Promise<string[]> {
  if (viewer.layout === 'phone') return viewer.page.evaluate(boardRowIds);
  return viewer.page.evaluate(pillIds);
}

async function probeCardLive(viewer: Viewer, sessionId: string): Promise<ProbeResult> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
  if (reading.dataWsState !== WEB_SOCKET_OPEN) {
    return { ok: false, detail: `data socket state ${String(reading.dataWsState)}`, reading };
  }
  return { ok: true, detail: `live at ${reading.cols}x${reading.rows}`, reading };
}

async function probeSettled(
  viewer: Viewer,
  sessionId: string,
  expectGrid: 'exact' | 'following',
  remembered: RememberedGrid | null,
): Promise<ProbeResult> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
  if (remembered && (reading.cols !== remembered.cols || reading.rows !== remembered.rows)) {
    return {
      ok: false,
      reading,
      detail: `grid is ${reading.cols}x${reading.rows}, wanted the remembered ${remembered.cols}x${remembered.rows}`,
    };
  }
  const authoritative = reading.ptySize;
  if (!authoritative) return { ok: false, detail: 'no authoritative pty size has arrived', reading };
  if (authoritative.cols !== reading.cols || authoritative.rows !== reading.rows) {
    return {
      ok: false,
      reading,
      detail: `pty is ${authoritative.cols}x${authoritative.rows} while the grid is ${reading.cols}x${reading.rows}`,
    };
  }
  if (reading.link !== 'live') {
    return { ok: false, reading, detail: `data-link is ${String(reading.link)}, wanted live` };
  }
  if (reading.dataGrid !== expectGrid) {
    return { ok: false, reading, detail: `data-grid is ${String(reading.dataGrid)}, wanted ${expectGrid}` };
  }
  const engagement = await viewer.page.evaluate(readDocumentEngagement);
  if (engagement.visibilityState === 'hidden') {
    return { ok: true, reading, isDrawingDeferred: true, detail: `settled at ${reading.cols}x${reading.rows} while hidden, drawing deferred until shown` };
  }
  if (reading.bufferLength !== reading.rows) {
    return { ok: false, reading, detail: `buffer holds ${reading.bufferLength} lines for ${reading.rows} rows` };
  }
  const statusRow = reading.lines[reading.rows - 1] ?? '';
  const status = parseStatusRow(statusRow);
  if (!status) return { ok: false, reading, detail: `last row carries no status: ${JSON.stringify(statusRow)}` };
  if (status.cols !== reading.cols || status.rows !== reading.rows) {
    return {
      ok: false,
      reading,
      tick: status.tick,
      detail: `agent painted ${status.cols}x${status.rows} while the grid is ${reading.cols}x${reading.rows}`,
    };
  }
  const mismatch = firstMismatch(expectedRows(reading.cols, reading.rows, status.tick), reading.lines);
  if (mismatch) {
    return { ok: false, reading, tick: status.tick, mismatch, detail: `row ${mismatch.index} differs from the ruler frame` };
  }
  return { ok: true, reading, tick: status.tick, detail: `settled at ${reading.cols}x${reading.rows} tick ${status.tick}` };
}

function writeDiffFile(artifacts: ArtifactPaths, key: string, mismatch: RowMismatch, detail: string): string {
  const diffPath = path.join(artifacts.diffsDir, `${key}.txt`);
  const body = [
    detail,
    `first differing row: ${mismatch.index}`,
    `expected: ${JSON.stringify(mismatch.expected)}`,
    `actual:   ${JSON.stringify(mismatch.actual)}`,
    '',
  ].join('\n');
  fs.writeFileSync(diffPath, body, 'utf8');
  return diffPath;
}

async function waitForPageReady(viewer: Viewer, expectedLayout: Layout, deadlines: Deadlines): Promise<PollResult> {
  return pollUntil(async () => {
    const layout = await viewer.page.evaluate(readLayout);
    if (!layout.appReady) return { ok: false, detail: 'the dashboard has not stamped app-ready' };
    if (layout.layout !== expectedLayout) {
      return { ok: false, detail: `layout is ${String(layout.layout)}, wanted ${expectedLayout}` };
    }
    return { ok: true, detail: `ready in the ${expectedLayout} layout` };
  }, { label: `page ready for viewer ${viewer.id}`, timeoutMs: deadlines.pageReadyMs, intervalMs: deadlines.pollIntervalMs });
}

async function runOpen(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const rosterEntry = viewer.page.locator(rosterSelector(viewer, sessionId)).first();
  const listed = await pollUntil(async () => {
    const isListed = await rosterEntry.count() > 0;
    if (isListed && await rosterEntry.isVisible()) return { ok: true, detail: 'the session is listed' };
    if (isListed && viewer.layout === 'desktop') {
      await viewer.page.locator(DESKTOP_ENTER_FOCUS_SELECTOR).first().click();
      return { ok: false, detail: 'the roster is listed behind another view' };
    }
    const ids = await listedIds(viewer);
    return { ok: false, detail: `${sessionId} is missing from ${ids.length} listed sessions` };
  }, { label: `session listed for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  if (!listed.ok) return failedOutcome('session-listed', listed.detail);
  await rosterEntry.click();
  const live = await pollUntil(
    () => probeCardLive(viewer, sessionId),
    { label: `card live for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs },
  );
  return outcomeFor('card-live', live);
}

async function runBack(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const selector = viewer.layout === 'phone' ? PHONE_BACK_SELECTOR : DESKTOP_LEAVE_FOCUS_SELECTOR;
  await viewer.page.locator(selector).first().click();
  const released = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: true, detail: 'the card no longer carries a terminal' };
    if (reading.dataGrid === 'exact') return { ok: false, reading, detail: 'the viewer still holds an exact grid claim' };
    return { ok: true, reading, detail: `released to ${String(reading.dataGrid)}` };
  }, { label: `viewer ${viewer.id} released the grid`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('grid-released', released);
}

async function waitForSettingsHistory(
  viewer: Viewer,
  label: string,
  expected: { phoneScreen: string; settingsScreen?: string; historyLength?: number; isNestedEntry?: boolean },
  deadlines: Deadlines,
): Promise<PollResult> {
  return pollUntil(async () => {
    const reading = await viewer.page.evaluate(readSettingsHistory);
    const mismatched = Object.entries(expected).filter(([field, value]) => reading[field as keyof typeof reading] !== value);
    if (mismatched.length > 0) return { ok: false, detail: `wanted ${JSON.stringify(expected)}, read ${JSON.stringify(reading)}` };
    return { ok: true, detail: JSON.stringify(reading) };
  }, { label, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
}

async function runAssertSettingsBack(viewer: Viewer, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.page.locator(PHONE_MORE_SELECTOR).first().click();
  await viewer.page.locator(PHONE_SETTINGS_MENU_SELECTOR).first().click();
  const atList = await waitForSettingsHistory(viewer, 'settings list shown', { phoneScreen: 'settings', settingsScreen: 'list' }, deadlines);
  if (!atList.ok) return failedOutcome('settings-list', atList.detail);
  const listHistoryLength = (await viewer.page.evaluate(readSettingsHistory)).historyLength;
  await viewer.page.locator(SETTINGS_SECTION_SELECTOR).first().click();
  const atSection = await waitForSettingsHistory(viewer, 'section has its own history entry', { phoneScreen: 'settings', settingsScreen: 'section', historyLength: listHistoryLength + 1, isNestedEntry: true }, deadlines);
  if (!atSection.ok) return failedOutcome('settings-section-entry', atSection.detail);
  await viewer.page.evaluate(() => history.back());
  const backAtList = await waitForSettingsHistory(viewer, 'back lands on the settings list', { phoneScreen: 'settings', settingsScreen: 'list', isNestedEntry: false }, deadlines);
  if (!backAtList.ok) return failedOutcome('settings-back-to-list', backAtList.detail);
  await viewer.page.evaluate(() => history.back());
  const backAtBoard = await waitForSettingsHistory(viewer, 'second back lands on the board', { phoneScreen: 'board' }, deadlines);
  return outcomeFor('settings-back-to-board', backAtBoard);
}

async function runKeyboard(viewer: Viewer, state: 'up' | 'down', deadlines: Deadlines): Promise<StepOutcome> {
  const keyboardHeight = viewer.viewport.keyboardHeight;
  if (state === 'up' && keyboardHeight === undefined) {
    return failedOutcome('keyboard-open', `${viewer.viewport.name} declares no keyboard height`);
  }
  if (state === 'up' && keyboardHeight !== undefined) {
    const keyboardUpHeight = heightWithKeyboardUp(viewer.height, keyboardHeight);
    viewer.restoreHeight = viewer.height;
    await viewer.page.setViewportSize({ width: viewer.width, height: keyboardUpHeight });
    viewer.height = keyboardUpHeight;
  }
  if (state === 'down') {
    await viewer.page.setViewportSize({ width: viewer.width, height: viewer.restoreHeight });
    viewer.height = viewer.restoreHeight;
  }
  const wanted = state === 'up' ? 'open' : 'closed';
  const settled = await pollUntil(async () => {
    const layout = await viewer.page.evaluate(readLayout);
    const isOpen = layout.keyboard === 'open';
    if (state === 'up' && isOpen) return { ok: true, detail: 'the shell reports an open keyboard' };
    if (state === 'down' && !isOpen) return { ok: true, detail: 'the shell reports a closed keyboard' };
    return { ok: false, detail: `data-keyboard is ${String(layout.keyboard)}, wanted ${wanted}` };
  }, { label: `keyboard ${state} for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor(`keyboard-${state}`, settled);
}

async function runType(viewer: Viewer, text: string): Promise<StepOutcome> {
  await viewer.page.locator(cardSlotSelector(viewer)).first().click();
  await viewer.page.keyboard.type(text);
  await viewer.page.keyboard.press('Enter');
  return passedOutcome('typed', `sent ${JSON.stringify(text)}`);
}

const LINK_HOVER_TIMEOUT_MS = 3000;

async function waitForLinkRowText(viewer: Viewer, sessionId: string, text: string, deadlines: Deadlines): Promise<PollResult> {
  return pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    const row = reading?.lines[LINK_ROW_NUMBER - 1] ?? '';
    return { ok: row.includes(text), reading, detail: `row ${LINK_ROW_NUMBER} reads ${JSON.stringify(row)}` };
  }, { label: `row ${LINK_ROW_NUMBER} shows ${text}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
}

async function waitForLinkHover(viewer: Viewer, label: string): Promise<PollResult> {
  const screen = viewer.page.locator(`${cardSlotSelector(viewer)} .xterm-screen`).first();
  return pollUntil(async () => {
    const isHovered = await screen.evaluate((element) => element.classList.contains('xterm-cursor-pointer'));
    return { ok: isHovered, detail: isHovered ? 'the link under the pointer is hovered' : 'no link is hovered under the pointer' };
  }, { label, timeoutMs: LINK_HOVER_TIMEOUT_MS, intervalMs: 50 });
}

type LinkPopupReading = { isVisible: boolean; host: string; mismatch: string; previewTitle: string; hasPreviewIcon: boolean; topPx: number; bottomPx: number; leftPx: number; rightPx: number };

type PointAt = (column: number, rowNumber: number) => [number, number];

const LINK_POPUP_HIDE_TIMEOUT_MS = 1000;
const LINK_POPUP_HOVER_HOLD_MS = 400;
const BLANK_COLUMN = 70;
const BLANK_ROW_NUMBER = 20;
const LINK_PREVIEW_SWEEP_MS = 200;
const LINK_PREVIEW_QUIET_MS = 800;
const LINK_PREVIEW_TIMEOUT_MS = 2000;
const HARNESS_PREVIEW_TITLE = 'Harness preview page';
const HARNESS_PREVIEW_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function recordLinkPreviewRequests(viewer: Viewer): Promise<string[]> {
  const requestedUrls: string[] = [];
  await viewer.page.route('**/link-preview', (route) => {
    const body: unknown = route.request().postDataJSON();
    const url = typeof body === 'object' && body !== null && 'url' in body ? String(body.url) : '';
    requestedUrls.push(url);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: HARNESS_PREVIEW_TITLE, iconDataUrl: HARNESS_PREVIEW_ICON }) });
  });
  return requestedUrls;
}

async function readLinkPopup(viewer: Viewer): Promise<LinkPopupReading> {
  return viewer.page.locator(`${cardSlotSelector(viewer)} .terminal-link-popup`).first().evaluate((popup) => {
    const bounds = popup.getBoundingClientRect();
    return {
      isVisible: !(popup as HTMLElement).hidden && bounds.height > 0,
      host: popup.querySelector('.terminal-link-popup-host')?.textContent ?? '',
      mismatch: popup.querySelector('.terminal-link-popup-mismatch')?.textContent ?? '',
      previewTitle: popup.querySelector('.terminal-link-popup-title')?.textContent ?? '',
      hasPreviewIcon: popup.querySelector('.terminal-link-popup-icon') !== null,
      topPx: bounds.top,
      bottomPx: bounds.bottom,
      leftPx: bounds.left,
      rightPx: bounds.right,
    };
  });
}

async function waitForLinkPopup(viewer: Viewer, label: string, isWanted: (reading: LinkPopupReading) => boolean, timeoutMs: number): Promise<PollResult> {
  return pollUntil(async () => {
    const reading = await readLinkPopup(viewer);
    return { ok: isWanted(reading), detail: JSON.stringify(reading) };
  }, { label, timeoutMs, intervalMs: 25 });
}

async function runAssertLinkPopup(viewer: Viewer, pointAt: PointAt, linkRowBottomPx: number, previewRequestUrls: string[]): Promise<StepOutcome | null> {
  const shown = await waitForLinkPopup(viewer, 'link popup shows the real host', (reading) => reading.isVisible && reading.host === 'example.com', LINK_HOVER_TIMEOUT_MS);
  if (!shown.ok) return outcomeFor('link-popup-shown', shown);
  const placed = await readLinkPopup(viewer);
  if (placed.topPx < linkRowBottomPx - 1) return failedOutcome('link-popup-below-row', `the popup top ${placed.topPx} covers the link row ending at ${linkRowBottomPx}`);
  if (placed.mismatch !== '') return failedOutcome('link-popup-no-mismatch', `plain link text showed a mismatch: ${placed.mismatch}`);
  await viewer.page.mouse.move((placed.leftPx + placed.rightPx) / 2, (placed.topPx + placed.bottomPx) / 2);
  await sleep(LINK_POPUP_HOVER_HOLD_MS);
  const held = await readLinkPopup(viewer);
  if (!held.isVisible) return failedOutcome('link-popup-hoverable', 'the popup closed while the pointer rested on it');
  await viewer.page.keyboard.press('Escape');
  const escaped = await waitForLinkPopup(viewer, 'Esc closes the link popup', (reading) => !reading.isVisible, 100);
  if (!escaped.ok) return outcomeFor('link-popup-escape', escaped);
  await viewer.page.keyboard.press('Enter');
  await viewer.page.mouse.move(...pointAt(BLANK_COLUMN, BLANK_ROW_NUMBER));
  await viewer.page.mouse.move(...pointAt(6, LINK_ROW_NUMBER));
  const reshown = await waitForLinkPopup(viewer, 'link popup shows again on re-entering the link', (reading) => reading.isVisible, LINK_HOVER_TIMEOUT_MS);
  if (!reshown.ok) return outcomeFor('link-popup-reshown', reshown);
  await viewer.page.mouse.move(...pointAt(BLANK_COLUMN, BLANK_ROW_NUMBER));
  const left = await waitForLinkPopup(viewer, 'leaving link and popup closes it', (reading) => !reading.isVisible, LINK_POPUP_HIDE_TIMEOUT_MS);
  if (!left.ok) return outcomeFor('link-popup-leave', left);
  await viewer.page.mouse.move(...pointAt(3, DECEPTIVE_LINK_ROW_NUMBER));
  await sleep(LINK_PREVIEW_SWEEP_MS);
  const passedOver = await readLinkPopup(viewer);
  if (!passedOver.isVisible) return failedOutcome('link-preview-sweep-popup', 'the popup did not show for the passed-over link');
  await viewer.page.mouse.move((passedOver.leftPx + passedOver.rightPx) / 2, (passedOver.topPx + passedOver.bottomPx) / 2);
  await sleep(LINK_PREVIEW_QUIET_MS);
  if (previewRequestUrls.includes(DECEPTIVE_LINK_URL)) return failedOutcome('link-preview-needs-dwell', 'passing over a link onto its popup fetched the page preview');
  await viewer.page.mouse.move(...pointAt(BLANK_COLUMN, BLANK_ROW_NUMBER));
  const sweptAway = await waitForLinkPopup(viewer, 'the passed-over popup closes', (reading) => !reading.isVisible, LINK_POPUP_HIDE_TIMEOUT_MS);
  if (!sweptAway.ok) return outcomeFor('link-preview-sweep-closed', sweptAway);
  await viewer.page.mouse.move(...pointAt(3, DECEPTIVE_LINK_ROW_NUMBER));
  const warned = await waitForLinkPopup(viewer, 'deceptive link text shows the mismatch warning', (reading) => reading.isVisible && reading.mismatch.includes('example.com') && reading.mismatch.includes('login.example.net'), LINK_HOVER_TIMEOUT_MS);
  if (!warned.ok) return outcomeFor('link-popup-mismatch', warned);
  const previewed = await waitForLinkPopup(viewer, 'resting on a link adds its page title and icon', (reading) => reading.isVisible && reading.previewTitle === HARNESS_PREVIEW_TITLE && reading.hasPreviewIcon, LINK_PREVIEW_TIMEOUT_MS);
  if (!previewed.ok) return outcomeFor('link-preview-after-dwell', previewed);
  if (!previewRequestUrls.includes(DECEPTIVE_LINK_URL)) return failedOutcome('link-preview-requested', `no preview request named ${DECEPTIVE_LINK_URL}: ${previewRequestUrls.join(', ')}`);
  return null;
}

async function runAssertLinkRepaint(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const previewRequestUrls = await recordLinkPreviewRequests(viewer);
  await runType(viewer, 'link-row');
  const plainShown = await waitForLinkRowText(viewer, sessionId, LINK_ROW_PLAIN_TEXT, deadlines);
  if (!plainShown.ok) return outcomeFor('link-row-plain', plainShown);
  const reading = plainShown.last?.reading ?? null;
  const bounds = await viewer.page.locator(`${cardSlotSelector(viewer)} .xterm-screen`).first().boundingBox();
  if (!reading || !bounds) return failedOutcome('link-row-bounds', 'the terminal screen has no grid or bounds');
  const cellWidth = bounds.width / reading.cols;
  const cellHeight = bounds.height / reading.rows;
  const pointAt = (column: number, rowNumber: number): [number, number] => [bounds.x + (column + 0.5) * cellWidth, bounds.y + (rowNumber - 0.5) * cellHeight];
  await viewer.page.mouse.move(...pointAt(4, LINK_ROW_NUMBER + 1));
  await viewer.page.mouse.move(...pointAt(4, LINK_ROW_NUMBER));
  await viewer.page.mouse.move(...pointAt(5, LINK_ROW_NUMBER));
  await sleep(200);
  await viewer.page.keyboard.type('link-paint');
  await viewer.page.keyboard.press('Enter');
  const linkShown = await waitForLinkRowText(viewer, sessionId, LINK_ROW_LINK_TEXT, deadlines);
  if (!linkShown.ok) return outcomeFor('link-row-painted', linkShown);
  const hoveredInPlace = await waitForLinkHover(viewer, 'link hovered under a resting pointer after an in-place repaint');
  if (!hoveredInPlace.ok) return outcomeFor('link-hover-after-repaint', hoveredInPlace);
  await viewer.page.keyboard.type('link-motion');
  await viewer.page.keyboard.press('Enter');
  const motionReported = await pollUntil(async () => {
    const motionReading = await readGridOf(viewer, sessionId);
    const row = motionReading?.lines[LINK_ROW_NUMBER + 1] ?? '';
    return { ok: row.includes(MOTION_REPORT_PREFIX), reading: motionReading, detail: row };
  }, { label: 'fake agent reports motion it received', timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  if (!motionReported.ok) return outcomeFor('link-motion-report', motionReported);
  if (!motionReported.detail.includes(`${MOTION_REPORT_PREFIX} 0`)) {
    return failedOutcome('link-recheck-sends-no-motion', `the agent received motion from the recheck: ${motionReported.detail}`);
  }
  await viewer.page.mouse.move(...pointAt(9, LINK_ROW_NUMBER));
  const hoveredAlongRow = await waitForLinkHover(viewer, 'link stays hovered moving along its row');
  if (!hoveredAlongRow.ok) return outcomeFor('link-hover-along-row', hoveredAlongRow);
  const popupFailure = await runAssertLinkPopup(viewer, pointAt, bounds.y + LINK_ROW_NUMBER * cellHeight, previewRequestUrls);
  if (popupFailure) return popupFailure;
  return passedOutcome('link-hover-after-repaint', `a link repainted under a resting pointer is hovered in place and along its row, the agent received no motion from the recheck, and the popup names the real host, stays while hovered, closes on Esc and on leave, warns on ${DECEPTIVE_LINK_TEXT}, and adds the page title only after a dwell`);
}

async function runOffline(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.context.setOffline(true);
  await viewer.page.evaluate(dropDataSocket, { sessionId, registryUrl: CARD_REGISTRY_URL });
  const dropped = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: true, detail: 'the card no longer carries a terminal' };
    if (reading.dataWsState === WEB_SOCKET_OPEN) return { ok: false, reading, detail: 'the data socket is still open' };
    return { ok: true, reading, detail: `data socket state ${String(reading.dataWsState)}` };
  }, { label: `viewer ${viewer.id} went offline`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('socket-dropped', dropped);
}

async function runOnline(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.context.setOffline(false);
  const reattached = await pollUntil(
    () => probeCardLive(viewer, sessionId),
    { label: `viewer ${viewer.id} reattached`, timeoutMs: deadlines.reattachMs, intervalMs: deadlines.pollIntervalMs },
  );
  return outcomeFor('socket-reattached', reattached);
}

async function runEngagement(viewer: Viewer, engaged: boolean, quiet: boolean): Promise<StepOutcome> {
  if (engaged && !quiet) await viewer.page.bringToFront();
  await viewer.page.evaluate(setDocumentEngagement, { engaged, quiet });
  const reading = await viewer.page.evaluate(readDocumentEngagement);
  const predicate = engaged ? 'viewer-foregrounded' : 'viewer-backgrounded';
  const detail = `hasFocus ${reading.hasFocus}, visibilityState ${reading.visibilityState}`;
  const isEngaged = reading.hasFocus && reading.visibilityState === 'visible';
  if (isEngaged !== engaged) return failedOutcome(predicate, detail);
  return passedOutcome(predicate, detail);
}

async function runWindowBlur(viewer: Viewer): Promise<StepOutcome> {
  await viewer.page.evaluate(setDocumentEngagement, { engaged: false, quiet: true });
  await viewer.page.evaluate(dispatchWindowBlur);
  const reading = await viewer.page.evaluate(readDocumentEngagement);
  const detail = `hasFocus ${reading.hasFocus}, visibilityState ${reading.visibilityState}`;
  if (reading.hasFocus || reading.visibilityState !== 'visible') return failedOutcome('window-blurred', detail);
  return passedOutcome('window-blurred', detail);
}

async function runTapTerminal(viewer: Viewer, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.page.locator(cardSlotSelector(viewer)).first().click();
  const focused = await pollUntil(async () => {
    const inTerminal = await viewer.page.evaluate(readTerminalFocus);
    if (!inTerminal) return { ok: false, detail: 'focus is outside the terminal wrapper' };
    return { ok: true, detail: 'the terminal holds focus' };
  }, { label: `terminal focus for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('terminal-focused', focused);
}

async function runAssertFit(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const fitted = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: false, detail: 'the terminal is missing' };
    const fits = reading.cols === reading.proposedCols && reading.ptySize?.cols === reading.cols
      && reading.screenLeft >= 0 && reading.screenRight <= reading.viewportWidth;
    return { ok: fits, reading, detail: `${reading.cols} cols, fit ${reading.proposedCols}, screen ${reading.screenLeft}..${reading.screenRight} within ${reading.viewportWidth}` };
  }, { label: 'terminal fits viewport', timeoutMs: deadlines.settleMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('terminal-fits', fitted);
}

async function runTouchScroll(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const hasHistory = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    return { ok: !!reading && reading.bufferLength > reading.rows && reading.viewportY > 0, reading, detail: `viewport ${reading?.viewportY}, buffer ${reading?.bufferLength}` };
  }, { label: 'scrollback available', timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  if (!hasHistory.ok) return outcomeFor('scrollback-available', hasHistory);
  const viewportBefore = hasHistory.last?.reading?.viewportY;
  const bounds = await viewer.page.locator(`${cardSlotSelector(viewer)} .xterm-screen`).first().boundingBox();
  if (!bounds) return failedOutcome('touch-scroll', 'the screen has no bounds');
  const touchSession = await viewer.context.newCDPSession(viewer.page);
  try {
    const x = Math.max(10, Math.min(viewer.width - 10, bounds.x + bounds.width / 2));
    const startY = bounds.y + Math.min(100, bounds.height / 4);
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
    for (let distance = 20; distance <= 120; distance += 20) {
      await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY + distance }] });
      await sleep(30);
    }
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await touchSession.detach();
  }
  const scrolled = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    return { ok: !!reading && reading.viewportY !== viewportBefore, reading, detail: `viewport ${viewportBefore} -> ${reading?.viewportY}` };
  }, { label: 'touch moves viewport', timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('touch-scroll', scrolled);
}

async function runRemember(
  viewer: Viewer,
  sessionId: string,
  label: string,
  rememberedByKey: Map<string, RememberedGrid>,
): Promise<StepOutcome> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return failedOutcome('grid-remembered', 'the session card carries no terminal to remember');
  rememberedByKey.set(`${viewer.id}:${label}`, { cols: reading.cols, rows: reading.rows });
  return passedOutcome('grid-remembered', `${label} is ${reading.cols}x${reading.rows}`);
}

async function readTick(viewer: Viewer, sessionId: string): Promise<number | null> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return null;
  const status = parseStatusRow(reading.lines[reading.rows - 1] ?? '');
  if (!status) return null;
  return status.tick;
}

async function runSettle(
  viewer: Viewer,
  sessionId: string,
  expectGrid: 'exact' | 'following',
  remembered: RememberedGrid | null,
  tickMustExceed: number | null,
  deadlines: Deadlines,
  artifacts: ArtifactPaths,
  key: string,
): Promise<StepOutcome> {
  let heldKey = '';
  let heldSince = 0;
  const settled = await pollUntil(async () => {
    const attempt = await probeSettled(viewer, sessionId, expectGrid, remembered);
    if (!attempt.ok) {
      heldKey = '';
      return attempt;
    }
    if (tickMustExceed !== null && !attempt.isDrawingDeferred && (attempt.tick ?? -1) <= tickMustExceed) {
      heldKey = '';
      return { ...attempt, ok: false, detail: `${attempt.detail}, still at or below the pre burst tick ${tickMustExceed}` };
    }
    const reached = attempt.reading;
    const fixpointKey = `${reached?.cols}x${reached?.rows}#${attempt.tick}`;
    if (fixpointKey !== heldKey) {
      heldKey = fixpointKey;
      heldSince = Date.now();
    }
    const heldMs = Date.now() - heldSince;
    if (heldMs >= GRID_SETTLE_HOLD_MS) return attempt;
    return { ...attempt, ok: false, detail: `${attempt.detail} but held only ${heldMs}ms` };
  }, { label: `grid fixpoint for viewer ${viewer.id}`, timeoutMs: deadlines.settleMs, intervalMs: deadlines.pollIntervalMs });
  const reading = settled.last?.reading ?? null;
  const tick = settled.last?.tick ?? null;
  const grid = reading ? snapshotOf(reading, tick) : null;
  if (settled.ok) return { ...passedOutcome('grid-fixpoint', settled.detail), grid };
  const mismatch = settled.last?.mismatch ?? null;
  const diffPath = mismatch ? writeDiffFile(artifacts, key, mismatch, settled.detail) : null;
  return { ok: false, predicate: 'grid-fixpoint', detail: settled.detail, grid, shot: null, mismatch, diffPath };
}

async function runWatchTerminal(viewer: Viewer, sessionId: string, tickAtWatchByViewer: Map<ViewerId, number>): Promise<StepOutcome> {
  const isWatched = await viewer.page.evaluate(watchTerminal, { sessionId, registryUrl: CARD_REGISTRY_URL });
  if (!isWatched) return failedOutcome('terminal-watched', 'the card has no terminal or data socket to watch');
  const tick = await readTick(viewer, sessionId);
  tickAtWatchByViewer.delete(viewer.id);
  if (tick !== null) tickAtWatchByViewer.set(viewer.id, tick);
  return passedOutcome('terminal-watched', `write count reset at tick ${String(tick)}`);
}

async function runExpectTerminalUntouched(viewer: Viewer, sessionId: string, durationMs: number): Promise<StepOutcome> {
  await sleep(durationMs);
  const watch = await viewer.page.evaluate(readTerminalWatch, { sessionId, registryUrl: CARD_REGISTRY_URL });
  if (!watch) return failedOutcome('terminal-untouched', 'the card has no terminal');
  const detail = `${watch.writeCount} terminal writes over ${durationMs}ms, data socket ${watch.isSameDataSocket ? 'kept' : 'replaced'}`;
  if (watch.writeCount !== 0 || !watch.isSameDataSocket) return failedOutcome('terminal-untouched', detail);
  return passedOutcome('terminal-untouched', detail);
}

async function runExpectRevealed(viewer: Viewer, sessionId: string, tickAtWatch: number | null, deadlines: Deadlines): Promise<StepOutcome> {
  if (tickAtWatch === null) return failedOutcome('reveal-baseline', 'no tick was recorded when the terminal was watched');
  const revealed = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
    if (reading.link !== 'live') return { ok: false, reading, detail: `data-link is ${String(reading.link)}, wanted live` };
    const watch = await viewer.page.evaluate(readTerminalWatch, { sessionId, registryUrl: CARD_REGISTRY_URL });
    if (!watch?.isSameDataSocket) return { ok: false, reading, detail: 'the data socket was replaced, wanted the page show to reuse it' };
    const status = parseStatusRow(reading.lines[reading.rows - 1] ?? '');
    if (!status) return { ok: false, reading, detail: 'last row carries no status' };
    if (status.tick <= tickAtWatch) {
      return { ok: false, reading, tick: status.tick, detail: `screen still shows tick ${status.tick}, painted at or before the hidden output` };
    }
    const mismatch = firstMismatch(expectedRows(reading.cols, reading.rows, status.tick), reading.lines);
    if (mismatch) return { ok: false, reading, tick: status.tick, mismatch, detail: `row ${mismatch.index} differs from the ruler frame` };
    const scrollbackLines = reading.bufferLength - reading.rows;
    if (scrollbackLines <= 0) return { ok: false, reading, tick: status.tick, detail: 'scrollback is empty, wanted the output from before the hide kept' };
    return { ok: true, reading, tick: status.tick, detail: `current at tick ${status.tick} with ${scrollbackLines} lines of scrollback` };
  }, { label: `reveal for viewer ${viewer.id}`, timeoutMs: deadlines.settleMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('revealed-current', revealed);
}

async function runLoadDeepHistory(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const attached = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
    if (reading.bufferLength <= reading.rows) return { ok: false, reading, detail: 'the attach has not drawn any scrollback yet' };
    return { ok: true, reading, detail: `${reading.bufferLength - reading.rows} lines of scrollback drawn` };
  }, { label: `scrollback before deep history for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  if (!attached.ok) return outcomeFor('deep-history-loaded', attached);
  const top = await viewer.page.evaluate(scrollTerminalToTop, { sessionId, registryUrl: CARD_REGISTRY_URL });
  if (!top) return failedOutcome('deep-history-loaded', 'the card has no terminal to scroll');
  const loaded = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: false, detail: 'the session card carries no terminal yet', reading: null };
    if (reading.link !== 'live') return { ok: false, reading, detail: `data-link is ${String(reading.link)}, wanted live` };
    if (reading.bufferLength <= top.bufferLength) {
      return { ok: false, reading, detail: `buffer holds ${reading.bufferLength} lines, no deeper than the ${top.bufferLength} at the top` };
    }
    const linesFromBottom = reading.bufferLength - reading.viewportY;
    const topLine = reading.lines[0] ?? '';
    if (topLine !== top.topLine || linesFromBottom !== top.linesFromBottom) {
      return {
        ok: false,
        reading,
        detail: `top row ${JSON.stringify(topLine)} sits ${linesFromBottom} lines from the bottom, wanted ${JSON.stringify(top.topLine)} at ${top.linesFromBottom}`,
      };
    }
    return { ok: true, reading, detail: `${reading.bufferLength} lines after ${top.bufferLength}, top row held its place` };
  }, { label: `deep history for viewer ${viewer.id}`, timeoutMs: deadlines.settleMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('deep-history-loaded', loaded);
}

async function runAssertGrid(
  viewer: Viewer,
  sessionId: string,
  tickOffset: number,
  artifacts: ArtifactPaths,
  key: string,
): Promise<StepOutcome> {
  const reading = await readGridOf(viewer, sessionId);
  if (!reading) return failedOutcome('grid-assertion', 'the session card carries no terminal');
  const statusRow = reading.lines[reading.rows - 1] ?? '';
  const status = parseStatusRow(statusRow);
  if (!status) {
    return failedOutcome('grid-assertion', `last row carries no status: ${JSON.stringify(statusRow)}`);
  }
  const wantedTick = status.tick + tickOffset;
  const mismatch = firstMismatch(expectedRows(reading.cols, reading.rows, wantedTick), reading.lines);
  const grid = snapshotOf(reading, status.tick);
  if (!mismatch) {
    return { ...passedOutcome('grid-assertion', `every row matches tick ${wantedTick}`), grid };
  }
  const detail = `row ${mismatch.index} differs from the frame expected at tick ${wantedTick}`;
  const diffPath = writeDiffFile(artifacts, key, mismatch, detail);
  return { ok: false, predicate: 'grid-assertion', detail, grid, shot: null, mismatch, diffPath };
}

async function runExpectLink(
  viewer: Viewer,
  sessionId: string,
  value: 'live' | 'connecting',
  deadlines: Deadlines,
): Promise<StepOutcome> {
  const linked = await pollUntil(async () => {
    const reading = await readGridOf(viewer, sessionId);
    if (!reading) return { ok: false, detail: 'the session card carries no terminal yet' };
    if (reading.link !== value) return { ok: false, reading, detail: `data-link is ${String(reading.link)}, wanted ${value}` };
    return { ok: true, reading, detail: `data-link is ${value}` };
  }, { label: `link ${value} for viewer ${viewer.id}`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('card-link', linked);
}

async function sendControlMessage(viewer: Viewer, controlMessage: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return viewer.page.evaluate(async (message) => {
    const tokenResponse = await fetch('/control-token');
    const { token } = await tokenResponse.json();
    const controlSocket = new WebSocket(`ws://${location.host}/control?token=${encodeURIComponent(token)}`);
    await new Promise((resolve) => controlSocket.addEventListener('open', resolve));
    const requestId = message.requestId;
    const reply = typeof requestId === 'string'
      ? new Promise<Record<string, unknown>>((resolve) => {
        controlSocket.addEventListener('message', (event) => {
          const frame = JSON.parse(event.data);
          if (frame.requestId === requestId) resolve(frame);
        });
      })
      : null;
    controlSocket.send(JSON.stringify(message));
    const answer = reply ? await reply : null;
    controlSocket.close();
    return answer;
  }, controlMessage);
}

async function runRemoveSession(viewer: Viewer, sessionId: string): Promise<StepOutcome> {
  const removal = { type: 'remove-session', id: sessionId, discardWork: true };
  const firstReply = await sendControlMessage(viewer, { ...removal, requestId: 'harness-remove' });
  if (firstReply?.ok === true) return passedOutcome('session-removed', 'removed on the first request');
  const confirmedReply = await sendControlMessage(viewer, { ...removal, requestId: 'harness-remove-confirm' });
  if (confirmedReply?.ok === true) return passedOutcome('session-removed', `removed after confirming: ${String(firstReply?.error)}`);
  return failedOutcome('session-removed', `the server kept the session: ${String(confirmedReply?.error)}`);
}

async function runRemoveFromPhoneTerminal(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  await viewer.page.evaluate(holdConfirmedSessionRemovals);
  await viewer.page.locator(PHONE_TERMINAL_MENU_SELECTOR).first().click();
  await viewer.page.locator(PHONE_TERMINAL_REMOVE_SELECTOR).first().click();
  await viewer.page.locator(CONFIRM_DIALOG_SELECTOR).first().click();
  const returnedToBoard = await pollUntil(async () => {
    const reading = await viewer.page.evaluate(readSettingsHistory);
    const isRemovingSessionListed = (await viewer.page.evaluate(boardRowIds)).includes(sessionId);
    if (isRemovingSessionListed) return { ok: false, detail: `the session being removed is still listed, on ${String(reading.phoneScreen)}` };
    if (reading.phoneScreen === 'board') return { ok: true, detail: 'the board is shown while the server still holds the session' };
    return { ok: false, detail: `still on ${String(reading.phoneScreen)}` };
  }, { label: `viewer ${viewer.id} back on the board after Remove`, timeoutMs: PHONE_REMOVE_RETURN_MS, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('returned-to-board', returnedToBoard);
}

const UNDO_CLOSE_WINDOW_MS = 8000;
const UNDO_CLOSE_SCALE_TOLERANCE = 0.1;
const UNDO_CLOSE_AWAY_MS = 3000;
const UNDO_CLOSE_REMOVAL_SLACK_MS = 4000;

function rosterItemSelector(viewer: Viewer, sessionId: string): string {
  const list = viewer.layout === 'phone' ? '.phone-board-list' : '.focus-rail';
  return `${list} .session-row-item:has(> button.session-row[data-id="${sessionId}"])`;
}

async function addUndoCloseSession(viewer: Viewer, projectDirectory: string, label: string): Promise<string> {
  const reply = await sendControlMessage(viewer, { type: 'add-session', name: `undo-close ${label}`, path: projectDirectory, prompt: 'stop', requestId: `harness-undo-close-${label}` });
  if (reply?.ok !== true || typeof reply.sessionId !== 'string') throw new Error(`add-session ${label} was refused: ${String(reply?.error)}`);
  return reply.sessionId;
}

async function readCloseCountdown(viewer: Viewer, sessionId: string): Promise<{ isListed: boolean; isClosing: boolean; scale: number | null }> {
  return viewer.page.evaluate((itemSelector) => {
    const item = document.querySelector(itemSelector);
    if (!item) return { isListed: false, isClosing: false, scale: null };
    const countdown = item.querySelector(':scope > .session-row-close-countdown');
    const transform = countdown ? getComputedStyle(countdown).transform : 'none';
    const scale = transform === 'none' ? null : new DOMMatrixReadOnly(transform).a;
    return { isListed: true, isClosing: item.hasAttribute('data-closing'), scale };
  }, rosterItemSelector(viewer, sessionId));
}

async function closeFromRoster(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<number> {
  const clickedAt = Date.now();
  await viewer.page.locator(`${rosterItemSelector(viewer, sessionId)} > [data-action="remove-session"]`).click();
  const closing = await pollUntil(async () => {
    const countdown = await readCloseCountdown(viewer, sessionId);
    return countdown.isClosing ? { ok: true, detail: 'closing' } : { ok: false, detail: `listed ${countdown.isListed}, not closing` };
  }, { label: `${sessionId} enters its undo window`, timeoutMs: deadlines.stepMs, intervalMs: 50 });
  if (!closing.ok) throw new Error(closing.detail);
  return clickedAt;
}

async function expectCountdownTracks(viewer: Viewer, sessionId: string, closedAt: number, label: string): Promise<string> {
  const countdown = await readCloseCountdown(viewer, sessionId);
  const expectedScale = Math.max(0, 1 - (Date.now() - closedAt) / UNDO_CLOSE_WINDOW_MS);
  if (!countdown.isClosing || countdown.scale === null) throw new Error(`${label}: the row is not closing (listed ${countdown.isListed})`);
  if (Math.abs(countdown.scale - expectedScale) > UNDO_CLOSE_SCALE_TOLERANCE) {
    throw new Error(`${label}: the undo line reads ${countdown.scale.toFixed(2)} of its width, ${expectedScale.toFixed(2)} is left of the window`);
  }
  return `${label} ${countdown.scale.toFixed(2)}~${expectedScale.toFixed(2)}`;
}

async function expectRowOpen(viewer: Viewer, sessionId: string, label: string, deadlines: Deadlines): Promise<void> {
  const open = await pollUntil(async () => {
    const countdown = await readCloseCountdown(viewer, sessionId);
    if (countdown.isListed && !countdown.isClosing) return { ok: true, detail: 'open' };
    return { ok: false, detail: `listed ${countdown.isListed}, closing ${countdown.isClosing}` };
  }, { label, timeoutMs: deadlines.stepMs, intervalMs: 50 });
  if (!open.ok) throw new Error(open.detail);
}

async function expectRemovedOnSchedule(viewer: Viewer, sessionId: string, closedAt: number, label: string, deadlines: Deadlines): Promise<void> {
  const removed = await pollUntil(async () => {
    const countdown = await readCloseCountdown(viewer, sessionId);
    return countdown.isListed ? { ok: false, detail: 'still listed' } : { ok: true, detail: 'gone' };
  }, { label: `${label} removed`, timeoutMs: Math.max(0, closedAt + UNDO_CLOSE_WINDOW_MS + UNDO_CLOSE_REMOVAL_SLACK_MS - Date.now()), intervalMs: deadlines.pollIntervalMs });
  if (!removed.ok) throw new Error(removed.detail);
  const removedAfterMs = Date.now() - closedAt;
  if (removedAfterMs < UNDO_CLOSE_WINDOW_MS) throw new Error(`${label} left the roster ${removedAfterMs}ms after Close, inside the undo window`);
}

async function leaveRosterAndReturn(viewer: Viewer, deadlines: Deadlines): Promise<void> {
  if (viewer.layout === 'phone') {
    await viewer.page.locator(PHONE_MORE_SELECTOR).first().click();
    await viewer.page.locator(PHONE_SETTINGS_MENU_SELECTOR).first().click();
    const atSettings = await waitForSettingsHistory(viewer, 'settings shown', { phoneScreen: 'settings' }, deadlines);
    if (!atSettings.ok) throw new Error(atSettings.detail);
    await sleep(UNDO_CLOSE_AWAY_MS);
    await viewer.page.evaluate(() => history.back());
    const atBoard = await waitForSettingsHistory(viewer, 'back on the board', { phoneScreen: 'board' }, deadlines);
    if (!atBoard.ok) throw new Error(atBoard.detail);
    return;
  }
  await viewer.page.locator(DESKTOP_LEAVE_FOCUS_SELECTOR).first().click();
  await viewer.page.locator('.focus-rail').first().waitFor({ state: 'hidden', timeout: deadlines.stepMs });
  await sleep(UNDO_CLOSE_AWAY_MS);
  await viewer.page.locator(DESKTOP_ENTER_FOCUS_SELECTOR).first().click();
  await viewer.page.locator('.focus-rail').first().waitFor({ state: 'visible', timeout: deadlines.stepMs });
}

async function runAssertUndoClose(viewer: Viewer, projectDirectory: string, deadlines: Deadlines): Promise<StepOutcome> {
  const findings: string[] = [];
  const [undone, leftBehind, firstToExpire, undoneByButton, lastToExpire] = await Promise.all(
    ['undone', 'left-behind', 'first-to-expire', 'undone-by-button', 'last-to-expire'].map((label) => addUndoCloseSession(viewer, projectDirectory, label)),
  );
  for (const sessionId of [undone, leftBehind, firstToExpire, undoneByButton, lastToExpire]) {
    await viewer.page.locator(`${rosterItemSelector(viewer, sessionId)} > button.session-row:is([data-state="IDLE"], [data-state="COMPLETE"])`).waitFor({ state: 'attached', timeout: deadlines.reattachMs });
  }

  await closeFromRoster(viewer, undone, deadlines);
  await sleep(1000);
  await viewer.page.locator(`${rosterItemSelector(viewer, undone)} > [data-action="undo-remove"]`).click();
  await expectRowOpen(viewer, undone, 'Undo restores the row', deadlines);
  findings.push('close then Undo restores');

  const leftBehindClosedAt = await closeFromRoster(viewer, leftBehind, deadlines);
  await leaveRosterAndReturn(viewer, deadlines);
  findings.push(await expectCountdownTracks(viewer, leftBehind, leftBehindClosedAt, 'after leaving and returning'));
  await expectRemovedOnSchedule(viewer, leftBehind, leftBehindClosedAt, 'the session closed before leaving', deadlines);
  findings.push('closes on schedule after leaving');

  const firstToExpireClosedAt = await closeFromRoster(viewer, firstToExpire, deadlines);
  await sleep(1000);
  const undoneByButtonClosedAt = await closeFromRoster(viewer, undoneByButton, deadlines);
  await sleep(1000);
  await closeFromRoster(viewer, lastToExpire, deadlines);
  await viewer.page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await viewer.page.keyboard.press('ControlOrMeta+z');
  await expectRowOpen(viewer, lastToExpire, 'Ctrl+Z undoes the newest close', deadlines);
  findings.push(await expectCountdownTracks(viewer, firstToExpire, firstToExpireClosedAt, 'oldest after Ctrl+Z'));
  findings.push(await expectCountdownTracks(viewer, undoneByButton, undoneByButtonClosedAt, 'middle after Ctrl+Z'));

  const lastToExpireClosedAt = await closeFromRoster(viewer, lastToExpire, deadlines);
  await sleep(500);
  await viewer.page.locator(`${rosterItemSelector(viewer, undoneByButton)} > [data-action="undo-remove"]`).click();
  await expectRowOpen(viewer, undoneByButton, 'Undo on one of three pending closes', deadlines);
  findings.push(await expectCountdownTracks(viewer, firstToExpire, firstToExpireClosedAt, 'oldest after another Undo'));
  findings.push(await expectCountdownTracks(viewer, lastToExpire, lastToExpireClosedAt, 'newest after another Undo'));

  await expectRemovedOnSchedule(viewer, firstToExpire, firstToExpireClosedAt, 'the oldest pending close', deadlines);
  findings.push(await expectCountdownTracks(viewer, lastToExpire, lastToExpireClosedAt, 'newest after the oldest expired'));
  await expectRemovedOnSchedule(viewer, lastToExpire, lastToExpireClosedAt, 'the newest pending close', deadlines);

  await expectRowOpen(viewer, undone, 'the first undone session stays', deadlines);
  await expectRowOpen(viewer, undoneByButton, 'the session undone by its button stays', deadlines);
  return passedOutcome('undo-close', findings.join('; '));
}

async function addSessionAwayFromIt(viewer: Viewer): Promise<void> {
  if (viewer.layout === 'phone') {
    await viewer.page.locator(PHONE_BACK_SELECTOR).first().click();
    await viewer.page.locator('.phone-board-list [data-action="add-group-session"]').first().click();
    return;
  }
  await viewer.page.locator(DESKTOP_LEAVE_FOCUS_SELECTOR).first().click();
  await viewer.page.keyboard.press('Alt+Shift+Digit0');
}

async function runAssertAddedSessionShown(viewer: Viewer, deadlines: Deadlines): Promise<StepOutcome> {
  const cardsBeforeAdd = new Set(await viewer.page.evaluate(sessionCardIds));
  await addSessionAwayFromIt(viewer);
  const shown = await pollUntil(async () => {
    const addedSessionId = (await viewer.page.evaluate(sessionCardIds)).find((id) => !cardsBeforeAdd.has(id));
    if (!addedSessionId) return { ok: false, detail: 'no added session is listed yet' };
    const shownSessionId = await viewer.page.evaluate((cardSelector) => document.querySelector<HTMLElement>(cardSelector)?.dataset.id ?? null, `${cardSlotSelector(viewer)} .session-card`);
    if (shownSessionId !== addedSessionId) return { ok: false, detail: `the card shown is ${String(shownSessionId)}, not the added ${addedSessionId}` };
    const phoneScreen = (await viewer.page.evaluate(readSettingsHistory)).phoneScreen;
    if (viewer.layout === 'phone' && phoneScreen !== 'terminal') return { ok: false, detail: `the phone shows ${String(phoneScreen)}, not the Terminal screen` };
    return probeCardLive(viewer, addedSessionId);
  }, { label: `viewer ${viewer.id} shows the added session`, timeoutMs: deadlines.stepMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('added-session-shown', shown);
}

async function runExpectSessionGone(viewer: Viewer, sessionId: string, deadlines: Deadlines): Promise<StepOutcome> {
  const rosterEntry = viewer.page.locator(rosterSelector(viewer, sessionId));
  const gone = await pollUntil(async () => {
    if (await rosterEntry.count() === 0) return { ok: true, detail: 'the session is no longer listed' };
    return { ok: false, detail: `${sessionId} is still listed` };
  }, { label: `session gone for viewer ${viewer.id}`, timeoutMs: deadlines.reattachMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('session-gone', gone);
}

function harnessSessionName(baseName: string, sessionId: string): string {
  return `${baseName} ${sessionId.slice(0, 8)}`;
}

async function runExpectSessionName(viewer: Viewer, sessionId: string, wantedName: string, timeoutMs: number, deadlines: Deadlines): Promise<StepOutcome> {
  const rosterName = viewer.page.locator(`${rosterSelector(viewer, sessionId)} .session-row-name`).first();
  const repainted = await pollUntil(async () => {
    const shownName = await rosterName.textContent();
    if (shownName === wantedName) return { ok: true, detail: `the roster row reads ${wantedName}` };
    return { ok: false, detail: `the roster row still reads ${shownName}` };
  }, { label: `roster renamed for viewer ${viewer.id}`, timeoutMs, intervalMs: deadlines.pollIntervalMs });
  return outcomeFor('roster-renamed', repainted);
}

async function runRenameSession(viewer: Viewer, sessionId: string, newName: string, deadlines: Deadlines): Promise<StepOutcome> {
  await sendControlMessage(viewer, { type: 'rename-session', id: sessionId, newName });
  if (viewer.layout === 'phone') await viewer.page.locator(PHONE_BACK_SELECTOR).first().click();
  return runExpectSessionName(viewer, sessionId, newName, deadlines.stepMs, deadlines);
}

async function takeShot(viewer: Viewer, artifacts: ArtifactPaths, key: string, name: string): Promise<StepOutcome> {
  const shotPath = path.join(artifacts.shotsDir, `${key}--${name}.png`);
  await viewer.page.screenshot({ path: shotPath, fullPage: false });
  return { ...passedOutcome('screenshot', shotPath), shot: shotPath };
}

function isDashboardSocketUrl(url: URL): boolean {
  return url.pathname === '/control' || url.pathname.startsWith('/terminals/');
}

function isSendableCloseCode(code: number | undefined): code is number {
  if (code === undefined) return false;
  return code === 1000 || (code >= 3000 && code <= 4999);
}

function forwardClose(target: WebSocketRoute, code: number | undefined, reason: string | undefined): void {
  if (!isSendableCloseCode(code)) {
    void target.close();
    return;
  }
  void target.close({ code, reason });
}

async function routeDashboardSockets(page: Page): Promise<() => number> {
  const routedSockets: RoutedSocket[] = [];
  await page.routeWebSocket(isDashboardSocketUrl, (pageSide) => {
    const serverSide = pageSide.connectToServer();
    const routed: RoutedSocket = { isSilenced: false };
    routedSockets.push(routed);
    pageSide.onMessage((message) => { if (!routed.isSilenced) serverSide.send(message); });
    serverSide.onMessage((message) => { if (!routed.isSilenced) pageSide.send(message); });
    pageSide.onClose((code, reason) => { if (!routed.isSilenced) forwardClose(serverSide, code, reason); });
    serverSide.onClose((code, reason) => { if (!routed.isSilenced) forwardClose(pageSide, code, reason); });
  });
  return () => {
    let newlySilencedCount = 0;
    for (const routed of routedSockets) {
      if (routed.isSilenced) continue;
      routed.isSilenced = true;
      newlySilencedCount += 1;
    }
    return newlySilencedCount;
  };
}

async function runSuspend(viewer: Viewer): Promise<StepOutcome> {
  const silencedCount = viewer.silenceOpenSockets();
  if (silencedCount === 0) return failedOutcome('sockets-silenced', 'no routed dashboard socket was open to silence');
  const backgrounded = await runEngagement(viewer, false, false);
  if (!backgrounded.ok) return backgrounded;
  return passedOutcome('sockets-silenced', `${silencedCount} dashboard sockets held open with no traffic, page hidden`);
}

async function createViewer(
  browser: Browser,
  viewerId: ViewerId,
  viewport: Viewport,
  layout: Layout,
  baseUrl: string,
  log: CaseLog,
  shouldRouteSockets: boolean,
): Promise<Viewer> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.hasTouch,
    isMobile: viewport.isMobile,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('console', (message: ConsoleMessage) => {
    const line = `[${viewerId}] ${message.type()}: ${safeTextTail(message.text(), 500)}`;
    pushBoundedLine(log.lines, line);
    if (message.type() === 'error') pushBoundedLine(log.consoleErrors, line);
  });
  page.on('pageerror', (error: Error) => {
    const line = `[${viewerId}] ${safeTextTail(error.stack ?? error.message, 800)}`;
    pushBoundedLine(log.lines, line);
    pushBoundedLine(log.pageErrors, line);
  });
  const silenceOpenSockets = shouldRouteSockets ? await routeDashboardSockets(page) : () => 0;
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  return {
    id: viewerId,
    viewport,
    layout,
    context,
    page,
    width: viewport.width,
    height: viewport.height,
    restoreHeight: viewport.height,
    silenceOpenSockets,
  };
}

async function closeViewer(viewer: Viewer | null): Promise<void> {
  if (!viewer) return;
  try {
    await viewer.context.close();
  } catch {}
}

export async function runCase({
  browser,
  harnessCase,
  sessionId,
  projectDirectory,
  baseUrl,
  artifacts,
  deadlines,
}: RunCaseOptions): Promise<CaseRecord> {
  const key = caseKey({ viewport: harnessCase.viewport.name, scenario: harnessCase.scenario.name });
  const log: CaseLog = { lines: [], consoleErrors: [], pageErrors: [] };
  const startedAt = Date.now();
  const steps: StepRecord[] = [];
  const shots: string[] = [];
  const logPath = path.join(artifacts.logsDir, `${key}.log`);
  let observedLayout: string | null = null;
  let outcome: Outcome = 'passed';
  let viewerA: Viewer | null = null;
  let viewerB: Viewer | null = null;

  const companionLayout = harnessCase.companion ? layoutFor(harnessCase.companion) : null;
  const shouldRouteSockets = needsSocketRoute(harnessCase.scenario);

  const viewerFor = async (viewerId: ViewerId): Promise<Viewer> => {
    if (viewerId === 'a') {
      if (viewerA) return viewerA;
      viewerA = await createViewer(browser, 'a', harnessCase.viewport, harnessCase.expectedLayout, baseUrl, log, shouldRouteSockets);
      const ready = await waitForPageReady(viewerA, harnessCase.expectedLayout, deadlines);
      const layout = await viewerA.page.evaluate(readLayout);
      observedLayout = layout.layout;
      if (!ready.ok) throw new Error(ready.detail);
      return viewerA;
    }
    if (viewerB) return viewerB;
    const companion = harnessCase.companion;
    if (!companion) throw new Error(`${key} asks for a companion viewer but declares no companion viewport`);
    const layout = companionLayout ?? 'desktop';
    viewerB = await createViewer(browser, 'b', companion, layout, baseUrl, log, shouldRouteSockets);
    const ready = await waitForPageReady(viewerB, layout, {
      ...deadlines,
      pageReadyMs: Math.min(deadlines.pageReadyMs, DEFAULT_DEADLINES.pageReadyMs),
    });
    if (!ready.ok) throw new Error(ready.detail);
    return viewerB;
  };

  const tickToPassAtNextSettleByViewer = new Map<ViewerId, number>();
  const tickAtWatchByViewer = new Map<ViewerId, number>();
  const rememberedGridByKey = new Map<string, RememberedGrid>();

  const runStep = async (step: ResolvedStep): Promise<StepOutcome> => {
    const viewer = await viewerFor(step.viewer ?? 'a');
    if (step.kind === 'assert-issues') {
      await verifyIssues(viewer.page, viewer.layout, sessionId);
      return passedOutcome('issues', 'queue filters, live states, descriptions, sessions and pane navigation verified');
    }
    if (step.kind === 'assert-boards') {
      await verifyBoards(viewer.page, viewer.layout, sessionId);
      return passedOutcome('boards', 'board create, live box add and Comic Mono board text verified');
    }
    if (step.kind === 'assert-board-scale') {
      return passedOutcome('board-scale', await verifyBoardScale(viewer.page, sessionId));
    }
    if (step.kind === 'assert-board-pane') {
      await verifyBoardPane(viewer.page, sessionId, projectDirectory);
      return passedOutcome('board-pane', 'connect board from the card menu, board chip opens the Board tab in Focus above the terminal');
    }
    if (step.kind === 'assert-rail-drag') {
      return passedOutcome('rail-drag', await verifyRailDrag(viewer.page, sessionId, projectDirectory));
    }
    if (step.kind === 'assert-team-review') {
      await verifyTeamReviewRows(viewer.page, viewer.layout, sessionId);
      return passedOutcome('team-review-rows', 'quiet rows, accessible names, repo refs and detail presentation verified');
    }
    if (step.kind === 'assert-review-merge') {
      await verifyReviewMerge(viewer.page, projectDirectory, step.upstream);
      return passedOutcome('review-merge', `upstream ${step.upstream}: Merge disabled with a stable label once clicked, then the expected Review, header and origin state`);
    }
    if (step.kind === 'assert-phone-changes') {
      await verifyPhoneChanges(viewer.page, projectDirectory);
      return passedOutcome('phone-changes-back', 'a tapped file opens its diff, back returns to the file list, back again returns to the terminal');
    }
    if (step.kind === 'assert-link-repaint') return runAssertLinkRepaint(viewer, sessionId, deadlines);
    if (step.kind === 'open') return runOpen(viewer, sessionId, deadlines);
    if (step.kind === 'back') return runBack(viewer, sessionId, deadlines);
    if (step.kind === 'assert-settings-back') return runAssertSettingsBack(viewer, deadlines);
    if (step.kind === 'resize') {
      await viewer.page.setViewportSize({ width: step.width, height: step.height });
      viewer.width = step.width;
      viewer.height = step.height;
      viewer.restoreHeight = step.height;
      return passedOutcome('resized', `${step.width}x${step.height}`);
    }
    if (step.kind === 'keyboard') return runKeyboard(viewer, step.state, deadlines);
    if (step.kind === 'type') return runType(viewer, step.text);
    if (step.kind === 'burst') {
      const tickBeforeBurst = await readTick(viewer, sessionId);
      if (tickBeforeBurst === null) {
        return failedOutcome('burst-baseline', 'no status row carried a tick to measure the burst against');
      }
      tickToPassAtNextSettleByViewer.set(viewer.id, tickBeforeBurst);
      return runType(viewer, `burst ${step.lines}`);
    }
    if (step.kind === 'offline') return runOffline(viewer, sessionId, deadlines);
    if (step.kind === 'online') return runOnline(viewer, sessionId, deadlines);
    if (step.kind === 'foreground') return runEngagement(viewer, true, step.quiet === true);
    if (step.kind === 'wait') {
      await sleep(step.durationMs);
      return passedOutcome('waited', `${step.durationMs}ms passed`);
    }
    if (step.kind === 'background') return runEngagement(viewer, false, step.quiet === true);
    if (step.kind === 'suspend') return runSuspend(viewer);
    if (step.kind === 'window-blur') return runWindowBlur(viewer);
    if (step.kind === 'tap-terminal') return runTapTerminal(viewer, deadlines);
    if (step.kind === 'remember') return runRemember(viewer, sessionId, step.label, rememberedGridByKey);
    if (step.kind === 'settle') {
      const tickMustExceed = tickToPassAtNextSettleByViewer.get(viewer.id) ?? null;
      tickToPassAtNextSettleByViewer.delete(viewer.id);
      const remembered = step.expectRemembered === undefined
        ? null
        : rememberedGridByKey.get(`${viewer.id}:${step.expectRemembered}`) ?? null;
      return runSettle(viewer, sessionId, step.expectGrid ?? 'exact', remembered, tickMustExceed, deadlines, artifacts, key);
    }
    if (step.kind === 'assert-grid') {
      return runAssertGrid(viewer, sessionId, step.tickOffset ?? 0, artifacts, key);
    }
    if (step.kind === 'assert-fit') return runAssertFit(viewer, sessionId, deadlines);
    if (step.kind === 'touch-scroll') return runTouchScroll(viewer, sessionId, deadlines);
    if (step.kind === 'fit-measurement') {
      const changed = await viewer.page.evaluate(setFitMeasurement, { sessionId, registryUrl: CARD_REGISTRY_URL, available: step.available });
      if (!changed) return failedOutcome('fit-measurement', 'the fit addon is missing');
      return passedOutcome('fit-measurement', `measurement available: ${step.available}`);
    }
    if (step.kind === 'expect-link') return runExpectLink(viewer, sessionId, step.value, deadlines);
    if (step.kind === 'watch-terminal') return runWatchTerminal(viewer, sessionId, tickAtWatchByViewer);
    if (step.kind === 'expect-terminal-untouched') return runExpectTerminalUntouched(viewer, sessionId, step.durationMs);
    if (step.kind === 'expect-revealed') return runExpectRevealed(viewer, sessionId, tickAtWatchByViewer.get(viewer.id) ?? null, deadlines);
    if (step.kind === 'remove-session') return runRemoveSession(viewer, sessionId);
    if (step.kind === 'assert-undo-close') return runAssertUndoClose(viewer, projectDirectory, deadlines);
    if (step.kind === 'assert-added-session-shown') return runAssertAddedSessionShown(viewer, deadlines);
    if (step.kind === 'remove-from-phone-terminal') return runRemoveFromPhoneTerminal(viewer, sessionId, deadlines);
    if (step.kind === 'expect-session-gone') return runExpectSessionGone(viewer, sessionId, deadlines);
    if (step.kind === 'rename-session') return runRenameSession(viewer, sessionId, harnessSessionName(step.newName, sessionId), deadlines);
    if (step.kind === 'expect-session-name') return runExpectSessionName(viewer, sessionId, harnessSessionName(step.name, sessionId), deadlines.reattachMs, deadlines);
    if (step.kind === 'load-deep-history') return runLoadDeepHistory(viewer, sessionId, deadlines);
    const shot = await takeShot(viewer, artifacts, key, step.name);
    if (shot.shot) shots.push(shot.shot);
    return shot;
  };

  try {
    for (const [index, step] of harnessCase.scenario.steps.entries()) {
      const stepStartedAt = Date.now();
      let result: StepOutcome;
      try {
        result = await runStep(step);
      } catch (error) {
        result = failedOutcome('driver', safeTextTail(errorText(error), 800));
      }
      const crashed = log.pageErrors.length > 0;
      const stepFailed = !result.ok || crashed;
      steps.push({
        index,
        source: sourceOf(step),
        outcome: stepFailed ? 'failed' : 'passed',
        durationMs: Date.now() - stepStartedAt,
        grid: result.grid,
        shot: result.shot,
        failure: stepFailed
          ? {
            predicate: crashed && result.ok ? 'no-page-error' : result.predicate,
            detail: crashed && result.ok ? (log.pageErrors[0] ?? 'a page error was raised') : result.detail,
            firstDifferingRow: result.mismatch?.index ?? null,
            expectedRow: result.mismatch?.expected ?? null,
            actualRow: result.mismatch?.actual ?? null,
            diffPath: result.diffPath,
          }
          : null,
      });
      if (!stepFailed) continue;
      outcome = 'failed';
      break;
    }
  } catch (error) {
    outcome = 'failed';
    steps.push({
      index: steps.length,
      source: 'case',
      outcome: 'failed',
      durationMs: 0,
      grid: null,
      shot: null,
      failure: {
        predicate: 'driver',
        detail: safeTextTail(errorText(error), 800),
        firstDifferingRow: null,
        expectedRow: null,
        actualRow: null,
        diffPath: null,
      },
    });
  }

  if (outcome === 'failed' && viewerA) {
    try {
      const failureShot = await takeShot(viewerA, artifacts, key, 'failure');
      if (failureShot.shot) shots.push(failureShot.shot);
    } catch {}
  }

  await closeViewer(viewerB);
  await closeViewer(viewerA);

  fs.writeFileSync(logPath, `${log.lines.join('\n')}\n`, 'utf8');

  if (outcome === 'failed' && harnessCase.scenario.optional === true) outcome = 'skipped';

  return {
    viewport: harnessCase.viewport.name,
    width: harnessCase.viewport.width,
    height: harnessCase.viewport.height,
    expectedLayout: harnessCase.expectedLayout,
    observedLayout,
    scenario: harnessCase.scenario.name,
    optional: harnessCase.scenario.optional === true,
    outcome,
    durationMs: Date.now() - startedAt,
    steps,
    shots,
    logPath,
    consoleErrors: log.consoleErrors,
    pageErrors: log.pageErrors,
  };
}

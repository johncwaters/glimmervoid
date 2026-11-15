import type { Page } from 'playwright-core';
import { seededRandom } from '../load-cost/whiteboard-board-generator.ts';
import { focusTerminalTextarea, keyboardTextOf, modifierState, recordTerminalInputs, sentInputs, terminalTextarea } from './key-strip.ts';
import { checkStep, describeAction, EMPTY_LINE, generateAction, graphemesOf, OUT_OF_BAND_PREFIX, rebuildLine, shrinkActions } from './typing-search-core.ts';
import type { AgentCommand, FieldWrite, OracleFailure, SearchAction, StepObservation } from './typing-search-core.ts';

interface TypingSearchOptions {
  seed: number;
  budgetSeconds: number;
}

interface ReplayFailure {
  stepIndex: number;
  failure: OracleFailure;
  observation: StepObservation;
}

declare global {
  interface Window { searchFieldWrites?: FieldWrite[]; isSearchDriverWriting?: boolean }
}

const SETTLE_MS = 30;
const ACTION_TIMEOUT_MS = 3000;
const AGENT_REPLY_SETTLE_MS = 150;
const SCROLL_STEP_PX = 15;
const BEL = '\x07';
const terminalWrap = '.phone-card-slot .terminal-wrap';
const stripKeys = '.phone-key-strip > [data-key]';

async function installFieldProbe(page: Page) {
  await page.locator(terminalTextarea).evaluate((element) => {
    window.searchFieldWrites = [];
    if (Object.hasOwn(element, 'value')) return;
    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (!valueDescriptor?.get || !valueDescriptor.set) return;
    const readValue = valueDescriptor.get;
    const writeValue = valueDescriptor.set;
    Object.defineProperty(element, 'value', {
      configurable: true,
      get() { return readValue.call(this); },
      set(next: string) {
        writeValue.call(this, next);
        window.searchFieldWrites?.push({ value: String(next), isByOurCode: window.isSearchDriverWriting !== true });
      },
    });
  });
}

async function settle(page: Page, extraMs: number) {
  await page.evaluate((waitMs) => new Promise<void>((resolve) => {
    setTimeout(() => requestAnimationFrame(() => resolve()), waitMs);
  }), extraMs);
}

type FieldEdit =
  | { kind: 'append'; text: string }
  | { kind: 'replace-composition'; previous: string; next: string }
  | { kind: 'replace-last-word'; word: string }
  | { kind: 'delete-last-grapheme' };

async function editFieldAsSoftKeyboard(page: Page, edit: FieldEdit, inputType: string, data: string | null, isComposing: boolean) {
  await page.locator(terminalTextarea).evaluate((element, { fieldEdit, eventInputType, eventData, isComposingEvent }) => {
    const textarea = element as HTMLTextAreaElement;
    const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(textarea.value), (grapheme) => grapheme.segment);
    const nextValueByKind = {
      append: () => textarea.value + (fieldEdit.kind === 'append' ? fieldEdit.text : ''),
      'replace-composition': () => {
        if (fieldEdit.kind !== 'replace-composition') return textarea.value;
        const withoutPrevious = textarea.value.endsWith(fieldEdit.previous) ? textarea.value.slice(0, textarea.value.length - fieldEdit.previous.length) : textarea.value;
        return withoutPrevious + fieldEdit.next;
      },
      'replace-last-word': () => textarea.value.replace(/\S+(\s*)$/, (_word, trailingSpace: string) => (fieldEdit.kind === 'replace-last-word' ? fieldEdit.word : '') + trailingSpace),
      'delete-last-grapheme': () => graphemes.slice(0, -1).join(''),
    };
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
    window.isSearchDriverWriting = true;
    textarea.value = nextValueByKind[fieldEdit.kind]();
    window.isSearchDriverWriting = false;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new InputEvent('input', { inputType: eventInputType, data: eventData, isComposing: isComposingEvent, bubbles: true }));
  }, { fieldEdit: edit, eventInputType: inputType, eventData: data, isComposingEvent: isComposing });
}

async function dispatchComposition(page: Page, type: 'compositionstart' | 'compositionend', data: string) {
  await page.locator(terminalTextarea).evaluate((element, { eventType, eventData }) => {
    element.dispatchEvent(new CompositionEvent(eventType, { data: eventData, bubbles: true }));
  }, { eventType: type, eventData: data });
}

async function composeWord(page: Page, word: string) {
  const letters = graphemesOf(word);
  await dispatchComposition(page, 'compositionstart', '');
  let previous = '';
  for (let count = 1; count <= letters.length; count += 1) {
    const composed = letters.slice(0, count).join('');
    await editFieldAsSoftKeyboard(page, { kind: 'replace-composition', previous, next: composed }, 'insertCompositionText', composed, true);
    previous = composed;
  }
  await dispatchComposition(page, 'compositionend', word);
}

async function touchDrag(page: Page, from: { x: number; y: number }, deltaY: number) {
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  const moves = Math.max(1, Math.abs(Math.round(deltaY / SCROLL_STEP_PX)));
  for (let move = 1; move <= moves; move += 1) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + (deltaY * move) / moves }] });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
}

async function tapAt(page: Page, point: { x: number; y: number }) {
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
}

async function pointInTerminal(page: Page, xFraction: number, yFraction: number) {
  const box = await page.locator(terminalWrap).boundingBox();
  if (!box) throw new Error('the phone terminal is not on screen');
  return { x: box.x + box.width * xFraction, y: box.y + box.height * yFraction };
}

async function sendToAgent(page: Page, command: AgentCommand) {
  await page.evaluate((frame) => window.terminalDataSocket?.send(JSON.stringify({ type: 'input', data: frame })), `${OUT_OF_BAND_PREFIX}${command}${BEL}`);
}

async function pasteIntoField(page: Page, text: string) {
  await page.locator(terminalTextarea).evaluate((element, pastedText) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', pastedText);
    const pasteEvent = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    element.dispatchEvent(pasteEvent);
    if (pasteEvent.defaultPrevented) return;
    const textarea = element as HTMLTextAreaElement;
    window.isSearchDriverWriting = true;
    textarea.value += pastedText;
    window.isSearchDriverWriting = false;
    textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: null, bubbles: true }));
  }, text);
}

const KEYBOARD_ACTION_KINDS = new Set<SearchAction['kind']>(['type', 'compose', 'autocorrect', 'keyboard-delete', 'press', 'paste']);

async function isKeyboardOpen(page: Page) {
  return page.evaluate((selector) => document.activeElement === document.querySelector(selector), terminalTextarea);
}

async function performAction(page: Page, action: SearchAction) {
  if (KEYBOARD_ACTION_KINDS.has(action.kind) && !(await isKeyboardOpen(page))) return;
  switch (action.kind) {
    case 'type':
      for (const letter of graphemesOf(action.text)) {
        await editFieldAsSoftKeyboard(page, { kind: 'append', text: letter }, 'insertText', letter, false);
      }
      return;
    case 'compose':
      return composeWord(page, action.word);
    case 'autocorrect':
      return editFieldAsSoftKeyboard(page, { kind: 'replace-last-word', word: action.replacement }, 'insertReplacementText', action.replacement, false);
    case 'keyboard-delete':
      return editFieldAsSoftKeyboard(page, { kind: 'delete-last-grapheme' }, 'deleteContentBackward', null, false);
    case 'press':
      return page.keyboard.press(action.key);
    case 'tap-terminal':
      return tapAt(page, await pointInTerminal(page, action.xFraction, action.yFraction));
    case 'scroll':
      return touchDrag(page, await pointInTerminal(page, 0.5, 0.5), action.lines * SCROLL_STEP_PX * 2);
    case 'strip-key': {
      const keys = page.locator(stripKeys);
      const keyCount = await keys.count();
      if (keyCount === 0) return;
      return keys.nth(action.position % keyCount).click({ timeout: ACTION_TIMEOUT_MS });
    }
    case 'paste':
      return pasteIntoField(page, action.text);
    case 'keyboard-close':
      return page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    case 'keyboard-open':
      return focusTerminalTextarea(page);
    case 'agent':
      return sendToAgent(page, action.command);
  }
}

async function performStep(page: Page, action: SearchAction): Promise<StepObservation> {
  await page.evaluate(() => { for (const hintCard of document.querySelectorAll('aside.feature-hint')) hintCard.remove(); });
  const fieldBefore = await keyboardTextOf(page);
  await recordTerminalInputs(page);
  await page.evaluate(() => { window.searchFieldWrites = []; });
  await performAction(page, action);
  await settle(page, action.kind === 'agent' ? AGENT_REPLY_SETTLE_MS : SETTLE_MS);
  return {
    action,
    sentBytes: (await sentInputs(page)).join(''),
    fieldBefore,
    fieldAfter: await keyboardTextOf(page),
    fieldWrites: await page.evaluate(() => window.searchFieldWrites ?? []),
  };
}

async function releaseCtrl(page: Page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await page.locator('[data-key="ctrl"]').count() === 0) return;
    if (!(await modifierState(page, 'ctrl')).isPressed) return;
    await page.locator('[data-key="ctrl"]').first().click({ timeout: ACTION_TIMEOUT_MS });
  }
}

async function resetToEmptyLine(page: Page) {
  for (const command of ['leave-fullscreen', 'mouse-off', 'focus-off'] as const) await sendToAgent(page, command);
  await releaseCtrl(page);
  await focusTerminalTextarea(page);
  await page.keyboard.press('Enter');
  await settle(page, AGENT_REPLY_SETTLE_MS);
}

async function prepareSearch(page: Page) {
  await focusTerminalTextarea(page);
  await recordTerminalInputs(page);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.terminalDataSocket !== undefined);
  await installFieldProbe(page);
  await resetToEmptyLine(page);
}

async function replayActions(page: Page, actions: SearchAction[]): Promise<ReplayFailure | null> {
  await resetToEmptyLine(page);
  let line = EMPTY_LINE;
  for (const [stepIndex, action] of actions.entries()) {
    const observation = await performStep(page, action).catch((error: unknown) => {
      throw new Error(`step ${stepIndex + 1} ${describeAction(action)}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    });
    line = rebuildLine(line, observation.sentBytes);
    const failure = checkStep(line, observation);
    if (failure) return { stepIndex, failure, observation };
  }
  return null;
}

function describeObservation(observation: StepObservation): string {
  return `sent ${JSON.stringify(observation.sentBytes)}, field ${JSON.stringify(observation.fieldBefore)} -> ${JSON.stringify(observation.fieldAfter)}, writes ${JSON.stringify(observation.fieldWrites)}`;
}

async function reportFailure(page: Page, options: TypingSearchOptions, actions: SearchAction[], found: ReplayFailure): Promise<never> {
  const replayCommand = `node harness/browser/harness.ts --only touch-typing-search --seed ${options.seed}`;
  console.log(`seed ${options.seed}: step ${found.stepIndex + 1} failed the ${found.failure.oracle} oracle: ${found.failure.message}; ${describeObservation(found.observation)}`);
  const confirmed = await replayActions(page, actions.slice(0, found.stepIndex + 1));
  if (!confirmed) {
    throw new Error(`seed ${options.seed}: step ${found.stepIndex + 1} failed the ${found.failure.oracle} oracle (${found.failure.message}) but did not reproduce on replay; flaky. Replay: ${replayCommand}`);
  }
  const shrinkDeadlineMs = Date.now() + options.budgetSeconds * 1000;
  const shortest = await shrinkActions(actions, confirmed.stepIndex, async (candidate) => (await replayActions(page, candidate)) !== null, () => Date.now() < shrinkDeadlineMs);
  const final = await replayActions(page, shortest) ?? confirmed;
  const report = [
    `seed ${options.seed}: step ${found.stepIndex + 1} failed the ${final.failure.oracle} oracle: ${final.failure.message}`,
    `confirmed on replay; shrunk ${found.stepIndex + 1} -> ${shortest.length} steps:`,
    ...shortest.map((action, index) => `  ${index + 1} ${describeAction(action)}`),
    `failing step: ${describeObservation(final.observation)}`,
    `replay: ${replayCommand}`,
  ].join('\n');
  console.log(report);
  throw new Error(report);
}

export async function searchTerminalTyping(page: Page, options: TypingSearchOptions): Promise<string> {
  console.log(`typing search seed ${options.seed}, budget ${options.budgetSeconds} s`);
  await prepareSearch(page);
  const random = seededRandom(options.seed);
  const deadlineMs = Date.now() + options.budgetSeconds * 1000;
  const actions: SearchAction[] = [];
  let line = EMPTY_LINE;
  while (Date.now() < deadlineMs) {
    const action = generateAction(random);
    actions.push(action);
    const observation = await performStep(page, action);
    line = rebuildLine(line, observation.sentBytes);
    const failure = checkStep(line, observation);
    if (failure) return reportFailure(page, options, actions, { stepIndex: actions.length - 1, failure, observation });
  }
  if (actions.length === 0) throw new Error(`seed ${options.seed}: the ${options.budgetSeconds} s budget ran no phone actions`);
  const summary = `seed ${options.seed}: ${actions.length} random phone actions in ${options.budgetSeconds} s, no oracle failure`;
  console.log(summary);
  return summary;
}

export type { TypingSearchOptions };

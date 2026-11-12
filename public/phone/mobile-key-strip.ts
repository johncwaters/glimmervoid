import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import type { MobileKey, TerminalTextAction } from '../mobile-keys.ts';
import type { StickyModifierEvent, StickyModifierState, StripContext } from '../mobile-keys.ts';
import { ALT_SLOT, ARROW_KEY_IDS, ARROWS_SLOT, arrowStepsForDrag, CONTROL_SLOT, isClipboardKey, isUploadKey, MORE_SHEET_SLOTS, terminalTextActionOf, mobileKeyBytes, MOBILE_KEYS, nextStickyModifierState, RAW_TYPING_SLOT, STRIP_SLOTS_BY_CONTEXT } from '../mobile-keys.ts';
import { uploadFileToSession } from '../session-upload.ts';
import { createLineIcon, KEYBOARD_ICON_PATH } from '../svg-dom.ts';

const CONTROL_BYTES_BY_SYMBOL: Readonly<Record<string, string>> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  '?': '\x7f',
};

function controlBytesForCharacter(character: string): string | null {
  if (character.length !== 1) return null;
  const lowerCase = character.toLowerCase();
  if (lowerCase >= 'a' && lowerCase <= 'z') return String.fromCharCode(lowerCase.charCodeAt(0) - 96);
  return CONTROL_BYTES_BY_SYMBOL[character] ?? null;
}

interface MobileKeyStripOptions {
  send: (data: string | null | undefined) => void;
  getSessionId?: () => string | null | undefined;
  reportProblem: (text: string) => void;
  toggleKeyboard: () => void;
  toggleRawTyping: () => void;
  pasteText: (text: string) => void;
  runTextAction: (action: TerminalTextAction) => void;
}

const DOUBLE_TAP_WINDOW_MS = 350;
const REPEAT_START_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

function applyModifiers(bytes: string, { isControlHeld, isAltHeld }: { isControlHeld: boolean; isAltHeld: boolean }) {
  const controlled = isControlHeld ? controlBytesForCharacter(bytes) ?? bytes : bytes;
  return isAltHeld ? `\x1b${controlled}` : controlled;
}

function createStickyModifier(label: string, slotId: string) {
  const modifierButton = createPressable('phone-key phone-key-modifier', label);
  modifierButton.dataset.key = slotId;
  modifierButton.setAttribute('aria-pressed', 'false');
  modifierButton.addEventListener('pointerdown', (event) => event.preventDefault());
  let modifierState: StickyModifierState = 'off';
  let lastTapAtMs = 0;

  function apply(event: StickyModifierEvent) {
    modifierState = nextStickyModifierState(modifierState, event);
    modifierButton.setAttribute('aria-pressed', String(modifierState !== 'off'));
    modifierButton.toggleAttribute('data-locked', modifierState === 'locked');
  }

  modifierButton.addEventListener('click', (event) => {
    const isDoubleTap = event.timeStamp - lastTapAtMs < DOUBLE_TAP_WINDOW_MS && modifierState === 'once';
    lastTapAtMs = event.timeStamp;
    apply(isDoubleTap ? 'double-tap' : 'tap');
  });

  return {
    element: modifierButton,
    isHeld: () => modifierState !== 'off',
    consume: () => apply('key-sent'),
  };
}

export function createMobileKeyStrip({ send, getSessionId, reportProblem, toggleKeyboard, toggleRawTyping, pasteText, runTextAction }: MobileKeyStripOptions) {
  const strip = el('div', 'phone-key-strip');
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Terminal keys');

  const moreSheet = el('div', 'phone-key-more-sheet');
  moreSheet.id = 'phone-key-more-sheet';
  moreSheet.setAttribute('role', 'toolbar');
  moreSheet.setAttribute('aria-label', 'More terminal keys');
  moreSheet.hidden = true;

  const container = el('div', 'phone-key-block');
  container.append(moreSheet, strip);

  let filePicker: HTMLInputElement | null = null;
  let pickingButton: HTMLButtonElement | null = null;
  let shownContext: StripContext | null = null;

  const control = createStickyModifier('Ctrl', CONTROL_SLOT);
  const alt = createStickyModifier('Alt', ALT_SLOT);

  function modifiersHeld() {
    return { isControlHeld: control.isHeld(), isAltHeld: alt.isHeld() };
  }

  function consumeModifiers() {
    control.consume();
    alt.consume();
  }

  function sendWithModifiers(bytes: string | null) {
    if (bytes === null) return;
    send(applyModifiers(bytes, modifiersHeld()));
    consumeModifiers();
  }

  function takeModifiedCharacter(character: string) {
    if (!control.isHeld() && !alt.isHeld()) return null;
    if (control.isHeld() && !controlBytesForCharacter(character)) return null;
    const modifiedBytes = applyModifiers(character, modifiersHeld());
    consumeModifiers();
    return modifiedBytes;
  }

  const stopKeyRepeats: Array<() => void> = [];
  const slotElementsById = new Map<string, HTMLElement[]>();
  const moreSlotElementsById = new Map<string, HTMLElement[]>();

  function buildKeyButton(key: Readonly<MobileKey>) {
    const keyButton = createPressable(key.isArrow ? 'phone-key phone-key-arrow' : 'phone-key', key.label);
    keyButton.dataset.key = key.id;
    keyButton.setAttribute('aria-label', key.title);
    keyButton.addEventListener('pointerdown', (event) => event.preventDefault());
    if (key.repeats) stopKeyRepeats.push(wireHoldToRepeat(keyButton, () => sendWithModifiers(mobileKeyBytes(key.id))));
    if (!key.repeats) keyButton.addEventListener('click', () => pressKey(key, keyButton));
    return keyButton;
  }

  for (const key of MOBILE_KEYS) {
    slotElementsById.set(key.id, [buildKeyButton(key)]);
    if (MORE_SHEET_SLOTS.includes(key.id)) moreSlotElementsById.set(key.id, [buildKeyButton(key)]);
  }
  slotElementsById.set(ARROWS_SLOT, [createArrowPad(sendWithModifiers), ...ARROW_KEY_IDS.flatMap((id) => slotElementsById.get(id) ?? [])]);
  slotElementsById.set(CONTROL_SLOT, [control.element]);
  moreSlotElementsById.set(CONTROL_SLOT, [control.element]);
  moreSlotElementsById.set(ALT_SLOT, [alt.element]);

  const rawTypingToggle = createPressable('phone-key', 'Raw');
  rawTypingToggle.dataset.key = RAW_TYPING_SLOT;
  rawTypingToggle.setAttribute('aria-label', 'Raw typing');
  rawTypingToggle.setAttribute('aria-pressed', 'false');
  rawTypingToggle.addEventListener('pointerdown', (event) => event.preventDefault());
  rawTypingToggle.addEventListener('click', () => toggleRawTyping());
  moreSlotElementsById.set(RAW_TYPING_SLOT, [rawTypingToggle]);

  function setRawTypingChosen(isChosen: boolean) {
    rawTypingToggle.setAttribute('aria-pressed', String(isChosen));
  }

  const moreButton = createPressable('phone-key phone-key-more', 'More');
  moreButton.setAttribute('aria-label', 'More keys');
  moreButton.setAttribute('aria-expanded', 'false');
  moreButton.setAttribute('aria-controls', moreSheet.id);
  moreButton.addEventListener('pointerdown', (event) => event.preventDefault());
  moreButton.addEventListener('click', () => setMoreSheetOpen(moreButton.getAttribute('aria-expanded') !== 'true'));

  function setMoreSheetOpen(isOpen: boolean) {
    moreSheet.hidden = !isOpen;
    moreButton.setAttribute('aria-expanded', String(isOpen));
  }

  moreSheet.addEventListener('click', (event) => {
    const pressedKey = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-key]') : null;
    if (!pressedKey || pressedKey.dataset.key === ALT_SLOT || pressedKey.dataset.key === CONTROL_SLOT) return;
    setMoreSheetOpen(false);
  });

  const keyboardButton = createPressable('phone-key phone-key-keyboard');
  keyboardButton.append(createLineIcon(KEYBOARD_ICON_PATH, '1.5'));
  keyboardButton.setAttribute('aria-label', 'Keyboard');
  keyboardButton.setAttribute('aria-pressed', 'false');
  keyboardButton.addEventListener('pointerdown', (event) => event.preventDefault());
  keyboardButton.addEventListener('click', () => toggleKeyboard());

  function setKeyboardOpen(isOpen: boolean) {
    keyboardButton.setAttribute('aria-pressed', String(isOpen));
  }

  function setContext(context: StripContext) {
    if (shownContext === context) return;
    shownContext = context;
    for (const stopKeyRepeat of stopKeyRepeats) stopKeyRepeat();
    strip.dataset.context = context;
    const rowSlots = STRIP_SLOTS_BY_CONTEXT[context];
    strip.replaceChildren(...rowSlots.flatMap((slotId) => slotElementsById.get(slotId) ?? []), moreButton, keyboardButton);
    const sheetSlots = MORE_SHEET_SLOTS.filter((slotId) => !rowSlots.includes(slotId));
    moreSheet.replaceChildren(...sheetSlots.flatMap((slotId) => moreSlotElementsById.get(slotId) ?? []));
  }

  function pressKey(key: Readonly<MobileKey>, keyButton: HTMLButtonElement) {
    if (isUploadKey(key)) {
      openUploadPicker(keyButton);
      return;
    }
    if (isClipboardKey(key)) {
      pasteFromClipboard(pasteText, reportProblem);
      return;
    }
    const textAction = terminalTextActionOf(key);
    if (textAction) {
      runTextAction(textAction);
      return;
    }
    sendWithModifiers(mobileKeyBytes(key.id));
  }

  function openUploadPicker(keyButton: HTMLButtonElement) {
    pickingButton = keyButton;
    if (!filePicker) {
      filePicker = el('input', 'phone-file-picker');
      filePicker.type = 'file';
      filePicker.hidden = true;
      filePicker.addEventListener('change', onFilePicked);
      container.appendChild(filePicker);
    }
    filePicker.click();
  }

  function onFilePicked() {
    const picker = filePicker;
    if (!picker) return;
    const file = picker.files ? picker.files[0] : null;

    picker.value = '';
    if (!file) return;
    const sessionId = getSessionId?.();
    if (!sessionId) {
      reportProblem('No session is open to upload to.');
      return;
    }
    uploadPickedFile(sessionId, file, pickingButton);
  }

  async function uploadPickedFile(sessionId: string, file: File, keyButton: HTMLButtonElement | null) {
    if (keyButton) keyButton.disabled = true;
    await uploadFileToSession(sessionId, file);
    if (keyButton) keyButton.disabled = false;
  }

  setContext('ready');

  return { element: container, takeModifiedCharacter, setKeyboardOpen, setContext, setRawTypingChosen };
}

function wireHoldToRepeat(keyButton: HTMLButtonElement, press: () => void) {
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let heldPointerId: number | null = null;
  let hasRepeatedThisHold = false;

  function stopRepeating() {
    if (repeatTimer !== null) clearTimeout(repeatTimer);
    repeatTimer = null;
    heldPointerId = null;
    window.removeEventListener('pointerup', onWindowPointerEnd, true);
    window.removeEventListener('pointercancel', onWindowPointerEnd, true);
  }

  function onWindowPointerEnd(event: PointerEvent) {
    if (event.pointerId !== heldPointerId) return;
    stopRepeating();
  }

  function repeat() {
    hasRepeatedThisHold = true;
    press();
    repeatTimer = setTimeout(repeat, REPEAT_INTERVAL_MS);
  }

  keyButton.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    stopRepeating();
    hasRepeatedThisHold = false;
    heldPointerId = event.pointerId;
    window.addEventListener('pointerup', onWindowPointerEnd, true);
    window.addEventListener('pointercancel', onWindowPointerEnd, true);
    repeatTimer = setTimeout(repeat, REPEAT_START_DELAY_MS);
  });
  keyButton.addEventListener('click', (event) => {
    const isKeyboardActivation = event.detail === 0;
    if (hasRepeatedThisHold && !isKeyboardActivation) return;
    press();
  });

  return stopRepeating;
}

function createArrowPad(send: (data: string | null) => void) {
  const pad = createPressable('phone-key phone-arrow-pad', 'Swipe for arrows');
  let dragOrigin: { x: number; y: number } | null = null;
  let activePointerId: number | null = null;

  pad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (activePointerId !== null) return;
    pad.setPointerCapture(event.pointerId);
    activePointerId = event.pointerId;
    dragOrigin = { x: event.clientX, y: event.clientY };
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointerId || !dragOrigin) return;
    const arrowSteps = arrowStepsForDrag(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y);
    if (!arrowSteps) return;
    for (let step = 0; step < arrowSteps.stepCount; step++) send(mobileKeyBytes(arrowSteps.arrowKeyId));
    dragOrigin = { x: dragOrigin.x + arrowSteps.consumedX, y: dragOrigin.y + arrowSteps.consumedY };
  });
  const endDrag = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    dragOrigin = null;
  };
  pad.addEventListener('pointerup', endDrag);
  pad.addEventListener('pointercancel', endDrag);
  return pad;
}

const PASTE_PERMISSION_TEXT = 'Paste needs clipboard permission.';

function pasteFromClipboard(pasteText: (text: string) => void, reportProblem: (text: string) => void) {
  let read: Promise<string> | null | undefined = null;
  try {
    read = navigator.clipboard?.readText?.();
  } catch {
    reportProblem(PASTE_PERMISSION_TEXT);
    return;
  }
  if (!read) {
    reportProblem('Paste is unavailable in this browser.');
    return;
  }
  read
    .then((text) => { if (text) pasteText(text); })
    .catch(() => reportProblem(PASTE_PERMISSION_TEXT));
}

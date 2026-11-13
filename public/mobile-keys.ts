const CLIPBOARD_ACTION = 'clipboard';

const UPLOAD_ACTION = 'upload';

export type TerminalTextAction = 'select' | 'copy-screen' | 'copy-output';

const TERMINAL_TEXT_ACTIONS: ReadonlySet<string> = new Set<TerminalTextAction>(['select', 'copy-screen', 'copy-output']);

const ARROW_PAD_STEP_PX = 24;

export interface MobileKey {
  id: string;
  label: string;
  bytes: string | null;
  action?: string;
  isArrow?: boolean;
  repeats?: boolean;
  title: string;
}

export const MOBILE_KEYS: readonly Readonly<MobileKey>[] = Object.freeze([
  Object.freeze({ id: 'esc', label: 'Esc', bytes: '\x1b', title: 'Send Escape' }),
  Object.freeze({ id: 'tab', label: 'Tab', bytes: '\x09', title: 'Send Tab' }),
  Object.freeze({ id: 'shift-tab', label: `${String.fromCharCode(0x21e7)}Tab`, bytes: '\x1b[Z', title: 'Send Shift+Tab' }),
  Object.freeze({ id: 'left', label: String.fromCharCode(0x2190), bytes: '\x1b[D', isArrow: true, repeats: true, title: 'Arrow left' }),
  Object.freeze({ id: 'up', label: String.fromCharCode(0x2191), bytes: '\x1b[A', isArrow: true, repeats: true, title: 'Arrow up' }),
  Object.freeze({ id: 'down', label: String.fromCharCode(0x2193), bytes: '\x1b[B', isArrow: true, repeats: true, title: 'Arrow down' }),
  Object.freeze({ id: 'right', label: String.fromCharCode(0x2192), bytes: '\x1b[C', isArrow: true, repeats: true, title: 'Arrow right' }),
  Object.freeze({ id: 'enter', label: 'Enter', bytes: '\r', title: 'Send Enter' }),
  Object.freeze({ id: 'slash', label: '/', bytes: '/', title: 'Type a slash' }),
  Object.freeze({ id: 'at', label: '@', bytes: '@', title: 'Type an at sign' }),
  Object.freeze({ id: 'pipe', label: '|', bytes: '|', title: 'Type a pipe' }),
  Object.freeze({ id: 'tilde', label: '~', bytes: '~', title: 'Type a tilde' }),
  Object.freeze({ id: 'dash', label: '-', bytes: '-', title: 'Type a dash' }),
  Object.freeze({ id: 'q', label: 'q', bytes: 'q', title: 'Type q' }),
  Object.freeze({ id: 'paste', label: 'Paste', bytes: null, action: CLIPBOARD_ACTION, title: 'Paste from the clipboard' }),
  Object.freeze({ id: 'attach', label: 'Attach', bytes: null, action: UPLOAD_ACTION, title: 'Upload a photo or file to this session' }),
  Object.freeze({ id: 'select', label: 'Select', bytes: null, action: 'select', title: 'Select text from the terminal' }),
  Object.freeze({ id: 'copy-screen', label: 'Copy screen', bytes: null, action: 'copy-screen', title: 'Copy the text on screen' }),
  Object.freeze({ id: 'copy-output', label: 'Copy output', bytes: null, action: 'copy-output', title: 'Copy the last command output' }),
]);

export const ARROW_KEY_IDS: readonly string[] = Object.freeze(['left', 'up', 'down', 'right']);

export const ARROWS_SLOT = 'arrows';
export const CONTROL_SLOT = 'ctrl';
export const ALT_SLOT = 'alt';
export const RAW_TYPING_SLOT = 'raw';

export type StripContext = 'asking' | 'working' | 'ready' | 'fullscreen';

export const STRIP_SLOTS_BY_CONTEXT: Readonly<Record<StripContext, readonly string[]>> = Object.freeze({
  asking: Object.freeze(['esc', ARROWS_SLOT, 'enter']),
  working: Object.freeze(['esc', CONTROL_SLOT, 'shift-tab', ARROWS_SLOT, 'enter']),
  ready: Object.freeze(['esc', CONTROL_SLOT, 'shift-tab', 'slash', 'at', ARROWS_SLOT, 'enter']),
  fullscreen: Object.freeze(['esc', CONTROL_SLOT, 'tab', ARROWS_SLOT, 'q', 'enter']),
});

export const MORE_SHEET_SLOTS: readonly string[] = Object.freeze([ALT_SLOT, CONTROL_SLOT, 'tab', 'shift-tab', 'slash', 'pipe', 'tilde', 'dash', 'paste', 'attach', 'select', 'copy-screen', 'copy-output', RAW_TYPING_SLOT]);

const WORKING_STATES: ReadonlySet<string> = new Set(['INITIALIZING', 'STARTING', 'RUNNING']);

interface StripContextInputs {
  pendingPromptKind: string | null | undefined;
  state: string | null | undefined;
  bufferType: string | null | undefined;
  agentDrawsAlternateScreen: boolean;
}

interface FullScreenAppInputs {
  bufferType: string | null | undefined;
  agentDrawsAlternateScreen: boolean;
}

function isFullScreenAppShown({ bufferType, agentDrawsAlternateScreen }: FullScreenAppInputs) {
  return bufferType === 'alternate' && !agentDrawsAlternateScreen;
}

export function decideStripContext({ pendingPromptKind, state, bufferType, agentDrawsAlternateScreen }: StripContextInputs): StripContext {
  if (pendingPromptKind) return 'asking';
  if (isFullScreenAppShown({ bufferType, agentDrawsAlternateScreen })) return 'fullscreen';
  if (state && WORKING_STATES.has(state)) return 'working';
  return 'ready';
}

export function decideIsRawTyping({ isRawTypingChosen, ...fullScreenApp }: FullScreenAppInputs & { isRawTypingChosen: boolean }) {
  return isRawTypingChosen || isFullScreenAppShown(fullScreenApp);
}

const LINE_FEED_CODE = 0x0a;
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

export function isTextForCompose(data: string) {
  if (data === '') return false;
  for (const character of data) {
    const code = character.charCodeAt(0);
    if (code === LINE_FEED_CODE) continue;
    if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE) return false;
  }
  return true;
}

export type StickyModifierState = 'off' | 'once' | 'locked';
export type StickyModifierEvent = 'tap' | 'double-tap' | 'key-sent';

const STICKY_MODIFIER_TRANSITIONS: Readonly<Record<StickyModifierState, Readonly<Partial<Record<StickyModifierEvent, StickyModifierState>>>>> = Object.freeze({
  off: Object.freeze({ tap: 'once', 'double-tap': 'locked' }),
  once: Object.freeze({ tap: 'off', 'double-tap': 'locked', 'key-sent': 'off' }),
  locked: Object.freeze({ tap: 'off' }),
});

export function nextStickyModifierState(current: StickyModifierState, event: StickyModifierEvent): StickyModifierState {
  return STICKY_MODIFIER_TRANSITIONS[current][event] ?? current;
}

export function mobileKeyBytes(id: string) {
  const key = MOBILE_KEYS.find((k) => k.id === id);
  if (!key) return null;
  return key.bytes;
}

export function isClipboardKey(key: Pick<MobileKey, 'action'> | null | undefined) {
  return !!key && key.action === CLIPBOARD_ACTION;
}

function isTerminalTextAction(action: string | undefined): action is TerminalTextAction {
  return action !== undefined && TERMINAL_TEXT_ACTIONS.has(action);
}

export function terminalTextActionOf(key: Pick<MobileKey, 'action'> | null | undefined): TerminalTextAction | null {
  const action = key?.action;
  return isTerminalTextAction(action) ? action : null;
}

export function isUploadKey(key: Pick<MobileKey, 'action'> | null | undefined) {
  return !!key && key.action === UPLOAD_ACTION;
}

function arrowKeyIdForDrag(deltaX: number, deltaY: number, stepPx: number = ARROW_PAD_STEP_PX): string | null {
  const isHorizontal = Math.abs(deltaX) >= Math.abs(deltaY);
  const distance = isHorizontal ? deltaX : deltaY;
  if (Math.abs(distance) < stepPx) return null;
  if (isHorizontal) return distance > 0 ? 'right' : 'left';
  return distance > 0 ? 'down' : 'up';
}

export function arrowStepsForDrag(deltaX: number, deltaY: number, stepPx: number = ARROW_PAD_STEP_PX) {
  const arrowKeyId = arrowKeyIdForDrag(deltaX, deltaY, stepPx);
  if (!arrowKeyId) return null;
  const isHorizontal = arrowKeyId === 'left' || arrowKeyId === 'right';
  const distance = isHorizontal ? deltaX : deltaY;
  const stepCount = Math.floor(Math.abs(distance) / stepPx);
  const consumedPx = Math.sign(distance) * stepCount * stepPx;
  return {
    arrowKeyId,
    stepCount,
    consumedX: isHorizontal ? consumedPx : deltaX,
    consumedY: isHorizontal ? deltaY : consumedPx,
  };
}

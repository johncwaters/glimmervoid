const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const LEFT = String.fromCharCode(0x2190);
const RIGHT = String.fromCharCode(0x2192);
const MAC_COMMAND = String.fromCharCode(0x2318);
const MAC_OPTION = String.fromCharCode(0x2325);

type ShortcutPlatform = 'mac' | 'other';

type DashboardShortcutAction =
  | 'next-attention'
  | 'rail-step'
  | 'view-step'
  | 'session-nth'
  | 'new-session'
  | 'quick-session'
  | 'merge'
  | 'close-session'
  | 'resolve-or-resync'
  | 'streamer-mode';

interface ShortcutKeyEvent {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface ResolvedDashboardShortcut {
  action: DashboardShortcutAction;
  step: number;
}

interface DashboardShortcut {
  action: DashboardShortcutAction;
  keyCaptions: readonly string[];
  label: string;
  stepByCode: ReadonlyMap<string, number>;
  unavailablePlatform?: ShortcutPlatform;
  isShellChord?: boolean;
  needsMacOption?: boolean;
  needsShiftOffMac?: boolean;
}

interface ShortcutFocusContext {
  isTerminalFocused: boolean;
}

const SESSION_DIGIT_STEPS = Array.from({ length: 9 }, (_, index) => [`Digit${index + 1}`, index + 1] as const);

export const DEFAULT_NEXT_ATTENTION_KEY_CODE = 'KeyJ';

const PUNCTUATION_CAPTION_BY_CODE: ReadonlyMap<string, string> = new Map([
  ['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'], ['Semicolon', ';'],
  ['Quote', "'"], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['Backquote', '`'], ['Backslash', '\\'],
]);

const BROWSER_RESERVED_KEY_CODES: ReadonlySet<string> = new Set(['KeyQ', 'KeyW', 'KeyT', 'KeyN', 'KeyL', 'KeyR']);

const TEXT_EDITING_KEY_CODES: ReadonlySet<string> = new Set(['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ']);

function keyCaptionOf(code: string): string | null {
  const letterOrDigit = /^(?:Key|Digit)([A-Z0-9])$/.exec(code);
  if (letterOrDigit) return letterOrDigit[1];
  return PUNCTUATION_CAPTION_BY_CODE.get(code) ?? null;
}

function nextAttentionShortcut(keyCode: string): DashboardShortcut {
  return { action: 'next-attention', keyCaptions: [keyCaptionOf(keyCode) ?? keyCode], label: 'Jump to the next session needing you', stepByCode: new Map([[keyCode, 0]]) };
}

const FIXED_DASHBOARD_SHORTCUTS: readonly DashboardShortcut[] = [
  { action: 'rail-step', keyCaptions: [UP, DOWN], label: 'Previous / next session in the rail', stepByCode: new Map([['ArrowUp', -1], ['ArrowDown', 1]]) },
  { action: 'view-step', keyCaptions: [LEFT, RIGHT], label: 'Previous / next view tab', stepByCode: new Map([['ArrowLeft', -1], ['ArrowRight', 1]]), unavailablePlatform: 'other' },
  { action: 'view-step', keyCaptions: ['PgUp', 'PgDn'], label: 'Previous / next view tab', stepByCode: new Map([['PageUp', -1], ['PageDown', 1]]), unavailablePlatform: 'mac' },
  { action: 'session-nth', keyCaptions: ['1..9'], label: 'Jump to session 1 to 9', stepByCode: new Map(SESSION_DIGIT_STEPS), isShellChord: true, needsMacOption: true },
  { action: 'new-session', keyCaptions: ['0'], label: 'Add a session', stepByCode: new Map([['Digit0', 0]]), isShellChord: true },
  { action: 'quick-session', keyCaptions: ['0'], label: 'Add a session like the one you are in', stepByCode: new Map([['Digit0', 0]]), needsMacOption: true, needsShiftOffMac: true },
  { action: 'merge', keyCaptions: ['I'], label: 'Merge the selected session', stepByCode: new Map([['KeyI', 0]]) },
  { action: 'close-session', keyCaptions: ['K'], label: 'Close the selected session', stepByCode: new Map([['KeyK', 0]]) },
  { action: 'resolve-or-resync', keyCaptions: ['U'], label: 'Resolve a parked merge, or resync the base branch', stepByCode: new Map([['KeyU', 0]]), isShellChord: true },
  { action: 'streamer-mode', keyCaptions: ['\\'], label: 'Turn streamer mode on or off', stepByCode: new Map([['Backslash', 0]]), isShellChord: true },
];

function shortcutsOn(platform: ShortcutPlatform, nextAttentionKeyCode: string) {
  return [nextAttentionShortcut(nextAttentionKeyCode), ...FIXED_DASHBOARD_SHORTCUTS].filter((shortcut) => shortcut.unavailablePlatform !== platform);
}

function nextAttentionKeyRefusal(keyCode: string): string | null {
  if (keyCaptionOf(keyCode) === null) return 'Pick a letter, digit or punctuation key.';
  if (BROWSER_RESERVED_KEY_CODES.has(keyCode)) return 'The browser keeps that shortcut for itself.';
  if (TEXT_EDITING_KEY_CODES.has(keyCode)) return 'That shortcut stays with copy, cut, paste, select all and undo.';
  const taken = FIXED_DASHBOARD_SHORTCUTS.find((shortcut) => shortcut.stepByCode.has(keyCode));
  if (taken) return `That key is already used to ${taken.label.charAt(0).toLowerCase()}${taken.label.slice(1)}.`;
  return null;
}

export function isNextAttentionKeyCode(keyCode: unknown): keyCode is string {
  return typeof keyCode === 'string' && nextAttentionKeyRefusal(keyCode) === null;
}

type RecordedShortcutKey = { kind: 'recorded'; keyCode: string } | { kind: 'refused'; reason: string } | { kind: 'cancelled' } | { kind: 'ignored' };

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Meta', 'Alt', 'Control', 'Shift', 'OS']);

export function recordNextAttentionKey(event: ShortcutKeyEvent, platform: ShortcutPlatform): RecordedShortcutKey {
  if (event.key === 'Escape') return { kind: 'cancelled' };
  if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignored' };
  const modifier = platform === 'mac' ? 'Cmd' : 'Alt';
  if (!holdsOnlyShortcutModifier(event, platform, nextAttentionShortcut(event.code))) return { kind: 'refused', reason: `Hold ${modifier} alone while pressing the key.` };
  const refusal = nextAttentionKeyRefusal(event.code);
  if (refusal) return { kind: 'refused', reason: refusal };
  return { kind: 'recorded', keyCode: event.code };
}

export function shortcutPlatformFor(userAgent: string): ShortcutPlatform {
  return /Mac|iPhone|iPad/.test(userAgent) ? 'mac' : 'other';
}

function holdsOnlyShortcutModifier(event: ShortcutKeyEvent, platform: ShortcutPlatform, shortcut: DashboardShortcut) {
  if (event.ctrlKey) return false;
  if (platform === 'mac') return !event.shiftKey && event.metaKey && event.altKey === Boolean(shortcut.needsMacOption);
  return event.altKey && !event.metaKey && event.shiftKey === Boolean(shortcut.needsShiftOffMac);
}

function yieldsToShell(shortcut: DashboardShortcut, platform: ShortcutPlatform, focus: ShortcutFocusContext) {
  return focus.isTerminalFocused && platform !== 'mac' && Boolean(shortcut.isShellChord);
}

const NAVIGATION_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);

function catalogCodeOf(event: ShortcutKeyEvent) {
  return NAVIGATION_KEYS.has(event.key) ? event.key : event.code;
}

export function resolveDashboardShortcut(
  event: ShortcutKeyEvent,
  platform: ShortcutPlatform,
  focus: ShortcutFocusContext = { isTerminalFocused: false },
  nextAttentionKeyCode = DEFAULT_NEXT_ATTENTION_KEY_CODE,
): ResolvedDashboardShortcut | null {
  const catalogCode = catalogCodeOf(event);
  for (const shortcut of shortcutsOn(platform, nextAttentionKeyCode)) {
    const step = shortcut.stepByCode.get(catalogCode);
    if (step === undefined) continue;
    if (!holdsOnlyShortcutModifier(event, platform, shortcut)) continue;
    if (yieldsToShell(shortcut, platform, focus)) return null;
    return { action: shortcut.action, step };
  }
  return null;
}

export function escapesFocusedTerminal(shortcut: ResolvedDashboardShortcut, activeView: string | undefined) {
  return activeView === 'focus' || shortcut.action === 'quick-session';
}

function shortcutModifierCaption(platform: ShortcutPlatform, shortcut?: DashboardShortcut) {
  if (platform !== 'mac') return shortcut?.needsShiftOffMac ? 'Alt+Shift' : 'Alt';
  return shortcut?.needsMacOption ? `${MAC_COMMAND}${MAC_OPTION}` : MAC_COMMAND;
}

function findShortcut(action: DashboardShortcutAction, platform: ShortcutPlatform, nextAttentionKeyCode: string) {
  const shortcut = shortcutsOn(platform, nextAttentionKeyCode).find((candidate) => candidate.action === action);
  if (!shortcut) throw new Error(`Unknown dashboard shortcut: ${action}`);
  return shortcut;
}

export function shortcutChord(action: DashboardShortcutAction, platform: ShortcutPlatform, nextAttentionKeyCode = DEFAULT_NEXT_ATTENTION_KEY_CODE): string[] {
  const shortcut = findShortcut(action, platform, nextAttentionKeyCode);
  return [shortcutModifierCaption(platform, shortcut), shortcut.keyCaptions.join(' ')];
}

export function shortcutHint(action: DashboardShortcutAction, platform: ShortcutPlatform) {
  const [modifier, key] = shortcutChord(action, platform);
  return platform === 'mac' ? `${modifier}${key}` : `${modifier}+${key}`;
}

export function railAriaKeyShortcuts(platform: ShortcutPlatform) {
  const modifier = platform === 'mac' ? 'Meta' : 'Alt';
  return `ArrowUp ArrowDown ${modifier}+ArrowUp ${modifier}+ArrowDown`;
}

export function reviewPostChordText(platform: ShortcutPlatform): string {
  return platform === 'mac' ? 'Cmd+Enter' : 'Ctrl+Enter';
}

export function shortcutGroupsFor(platform: ShortcutPlatform, nextAttentionKeyCode = DEFAULT_NEXT_ATTENTION_KEY_CODE) {
  const terminalEditModifier = platform === 'mac' ? MAC_COMMAND : 'Ctrl';
  return [
    {
      title: 'Dashboard',
      items: shortcutsOn(platform, nextAttentionKeyCode).map((shortcut) => ({
        combos: shortcut.keyCaptions.map((key) => [shortcutModifierCaption(platform, shortcut), key]),
        label: shortcut.label,
      })),
    },
    {
      title: 'Navigation',
      items: [
        { combos: [[UP], [DOWN]], label: 'Move rail highlight (rail focused)' },
        { combos: [[LEFT], [RIGHT]], label: 'Switch view tab (tab focused)' },
      ],
    },
    {
      title: 'Reviews',
      items: [
        { combos: [['J'], ['K']], label: 'Next / previous pull request in the queue' },
        { combos: [['N'], ['P']], label: 'Next / previous finding' },
        { combos: [['X']], label: 'Post or drop the current finding' },
        { combos: [['O']], label: 'Open the pull request in a session' },
        { combos: [['A'], ['R'], ['C']], label: 'Pick Approve, Request changes or Comment' },
        { combos: [[terminalEditModifier, 'Enter']], label: 'Post the picked action, or the leading one from the note' },
        { combos: [['Esc']], label: 'Drop the picked action' },
      ],
    },
    {
      title: 'Terminal',
      items: [
        { combos: [[terminalEditModifier, 'C']], label: 'Copy selection' },
        { combos: [[terminalEditModifier, 'V']], label: 'Paste' },
        { combos: [[terminalEditModifier, 'Backspace']], label: 'Delete previous word' },
      ],
    },
    {
      title: 'General',
      items: [
        { combos: [['Esc']], label: 'Close dialog / cancel rename' },
      ],
    },
  ];
}

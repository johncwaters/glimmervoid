const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const LEFT = String.fromCharCode(0x2190);
const RIGHT = String.fromCharCode(0x2192);
const MAC_COMMAND = String.fromCharCode(0x2318);

export type ShortcutPlatform = 'mac' | 'other';

export type DashboardShortcutAction =
  | 'next-attention'
  | 'rail-step'
  | 'view-step'
  | 'session-nth'
  | 'new-session'
  | 'merge'
  | 'resolve-or-resync'
  | 'calm-home'
  | 'calm-terminal';

export interface ShortcutContext {
  isCalmAvailable: boolean;
  isCalmViewActive: boolean;
}

type ShortcutAvailability = 'always' | 'calm-surface' | 'calm-view';

const isActiveByAvailability: Record<ShortcutAvailability, (context: ShortcutContext) => boolean> = {
  always: () => true,
  'calm-surface': (context) => context.isCalmAvailable,
  'calm-view': (context) => context.isCalmAvailable && context.isCalmViewActive,
};

export interface ShortcutKeyEvent {
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
  availability: ShortcutAvailability;
  unavailablePlatform?: ShortcutPlatform;
}

const SESSION_DIGIT_STEPS = Array.from({ length: 9 }, (_, index) => [`Digit${index + 1}`, index + 1] as const);

const DASHBOARD_SHORTCUTS: readonly DashboardShortcut[] = [
  { action: 'next-attention', keyCaptions: ['J'], label: 'Jump to the next session needing you', stepByCode: new Map([['KeyJ', 0]]), availability: 'always' },
  { action: 'rail-step', keyCaptions: [UP, DOWN], label: 'Previous / next session in the rail', stepByCode: new Map([['ArrowUp', -1], ['ArrowDown', 1]]), availability: 'always' },
  { action: 'view-step', keyCaptions: [LEFT, RIGHT], label: 'Previous / next view tab', stepByCode: new Map([['ArrowLeft', -1], ['ArrowRight', 1]]), availability: 'always', unavailablePlatform: 'other' },
  { action: 'view-step', keyCaptions: ['PgUp', 'PgDn'], label: 'Previous / next view tab', stepByCode: new Map([['PageUp', -1], ['PageDown', 1]]), availability: 'always', unavailablePlatform: 'mac' },
  { action: 'session-nth', keyCaptions: ['1..9'], label: 'Jump to session 1 to 9', stepByCode: new Map(SESSION_DIGIT_STEPS), availability: 'always' },
  { action: 'new-session', keyCaptions: ['0'], label: 'Add a session', stepByCode: new Map([['Digit0', 0]]), availability: 'always' },
  { action: 'merge', keyCaptions: ['I'], label: 'Merge the selected session', stepByCode: new Map([['KeyI', 0]]), availability: 'always' },
  { action: 'resolve-or-resync', keyCaptions: ['U'], label: 'Resolve a parked merge, or resync the base branch', stepByCode: new Map([['KeyU', 0]]), availability: 'always' },
  { action: 'calm-home', keyCaptions: ['H'], label: 'Go to the Calm view (Calm layout)', stepByCode: new Map([['KeyH', 0]]), availability: 'calm-surface', unavailablePlatform: 'mac' },
  { action: 'calm-terminal', keyCaptions: ['T'], label: 'Open the terminal of the open Calm panel (Calm layout)', stepByCode: new Map([['KeyT', 0]]), availability: 'calm-view', unavailablePlatform: 'mac' },
];

function shortcutsOn(platform: ShortcutPlatform) {
  return DASHBOARD_SHORTCUTS.filter((shortcut) => shortcut.unavailablePlatform !== platform);
}

export function shortcutPlatformFor(userAgent: string): ShortcutPlatform {
  return /Mac|iPhone|iPad/.test(userAgent) ? 'mac' : 'other';
}

function holdsOnlyShortcutModifier(event: ShortcutKeyEvent, platform: ShortcutPlatform) {
  if (event.ctrlKey || event.shiftKey) return false;
  if (platform === 'mac') return event.metaKey && !event.altKey;
  return event.altKey && !event.metaKey;
}

export function resolveDashboardShortcut(event: ShortcutKeyEvent, platform: ShortcutPlatform, context: ShortcutContext): ResolvedDashboardShortcut | null {
  if (!holdsOnlyShortcutModifier(event, platform)) return null;
  for (const shortcut of shortcutsOn(platform)) {
    if (!isActiveByAvailability[shortcut.availability](context)) continue;
    const step = shortcut.stepByCode.get(event.code);
    if (step !== undefined) return { action: shortcut.action, step };
  }
  return null;
}

export function shortcutModifierCaption(platform: ShortcutPlatform) {
  return platform === 'mac' ? MAC_COMMAND : 'Alt';
}

function findShortcut(action: DashboardShortcutAction, platform: ShortcutPlatform) {
  const shortcut = shortcutsOn(platform).find((candidate) => candidate.action === action);
  if (!shortcut) throw new Error(`Unknown dashboard shortcut: ${action}`);
  return shortcut;
}

export function shortcutChord(action: DashboardShortcutAction, platform: ShortcutPlatform): string[] {
  return [shortcutModifierCaption(platform), findShortcut(action, platform).keyCaptions.join(' ')];
}

export function shortcutHint(action: DashboardShortcutAction, platform: ShortcutPlatform) {
  const [modifier, key] = shortcutChord(action, platform);
  return platform === 'mac' ? `${modifier}${key}` : `${modifier}+${key}`;
}

export function railAriaKeyShortcuts(platform: ShortcutPlatform) {
  const modifier = platform === 'mac' ? 'Meta' : 'Alt';
  return `ArrowUp ArrowDown ${modifier}+ArrowUp ${modifier}+ArrowDown`;
}

export function shortcutGroupsFor(platform: ShortcutPlatform) {
  const modifier = shortcutModifierCaption(platform);
  const terminalEditModifier = platform === 'mac' ? MAC_COMMAND : 'Ctrl';
  return [
    {
      title: 'Dashboard',
      items: shortcutsOn(platform).map((shortcut) => ({
        combos: shortcut.keyCaptions.map((key) => [modifier, key]),
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

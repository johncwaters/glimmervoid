import { playNyanJingle } from './alert-sound.ts';

const BASE_STATE_COLORS = {
  '--state-monitoring':   '#22d3ee',
  '--state-monitoring-bg': 'rgba(34, 211, 238, 0.06)',
  '--state-running':      '#22c55e',
  '--state-running-bg':   'rgba(34, 197, 94, 0.06)',
  '--state-waiting':      '#f59e0b',
  '--state-waiting-bg':   'rgba(245, 158, 11, 0.08)',
  '--state-failed':       '#ef4444',
  '--state-failed-bg':    'rgba(239, 68, 68, 0.06)',
  '--state-initializing': '#6b7280',
  '--state-initializing-bg': 'rgba(107, 114, 128, 0.06)',
  '--state-idle':         '#eab308',
  '--state-idle-bg':      'rgba(234, 179, 8, 0.06)',
};

const BASE_TERMINAL = {
  background:   '--bg-card',
  cursor:       '--accent',
  cursorAccent: '--bg-card',
  black:        '--border',
  brightBlack:  '--text-muted',
  red:          '#ef4444',
  brightRed:    '#f87171',
  green:        '#22c55e',
  brightGreen:  '#4ade80',
  yellow:       '#eab308',
  brightYellow: '#facc15',
  cyan:         '#06b6d4',
  brightCyan:   '#22d3ee',
};

interface ThemeDefinition {
  label: string;
  colors: Record<string, string>;
  terminal: Record<string, string>;
}

const THEMES: Record<string, ThemeDefinition> = {
  golgari: {
    label: 'Golgari (Green/Black)',
    colors: {
      '--bg':          '#060b08',
      '--bg-card':     '#0a120e',
      '--bg-header':   '#081009',
      '--bg-surface':  '#0e1a12',
      '--border':      '#1a2e1f',
      '--border-dim':  '#122016',
      '--border-hover':'#2a4a32',
      '--text':        '#b8ccbe',
      '--text-dim':    '#6a9070',
      '--text-head':   '#dceede',
      '--text-muted':  '#7a9a80',
      '--accent':      '#2dd4a0',
      '--accent-dim':  '#1a9a6e',

      ...BASE_STATE_COLORS,
      '--state-monitoring':   '#22d3ee',
      '--state-monitoring-bg': 'rgba(34, 211, 238, 0.08)',
      '--state-done':         '#2dd4a0',
      '--state-done-bg':      'rgba(45, 212, 160, 0.06)',
      '--state-starting':     '#a78bfa',
      '--state-starting-bg':  'rgba(167, 139, 250, 0.06)',
      '--state-complete':     '#34d399',
      '--state-complete-bg':  'rgba(52, 211, 153, 0.06)',
    },
    terminal: {
      ...BASE_TERMINAL,
      foreground:   '#c8dece',
      blue:         '--accent',
      brightBlue:   '#5ee8bc',
      magenta:      '#a855f7',
      brightMagenta:'#c084fc',
      white:        '#c8dece',
      brightWhite:  '#e8f5ea',
    },
  },

  midnight: {
    label: 'Midnight (Blue/Purple)',
    colors: {
      '--bg':          '#080816',
      '--bg-card':     '#0e0e20',
      '--bg-header':   '#0b0b1a',
      '--bg-surface':  '#131328',
      '--border':      '#1c1c38',
      '--border-dim':  '#141430',
      '--border-hover':'#2a2a50',
      '--text':        '#b8b8d4',
      '--text-dim':    '#8585b3',
      '--text-head':   '#dcdcf0',
      '--text-muted':  '#7c7ca9',
      '--accent':      '#4f6ef7',
      '--accent-dim':  '#3a54c0',

      ...BASE_STATE_COLORS,
      '--state-monitoring':   '#22d3ee',
      '--state-monitoring-bg': 'rgba(34, 211, 238, 0.08)',
      '--state-done':         '#3b82f6',
      '--state-done-bg':      'rgba(59, 130, 246, 0.06)',
      '--state-starting':     '#a855f7',
      '--state-starting-bg':  'rgba(168, 85, 247, 0.06)',
      '--state-complete':     '#60a5fa',
      '--state-complete-bg':  'rgba(96, 165, 250, 0.06)',
    },
    terminal: {
      ...BASE_TERMINAL,
      foreground:   '#c8c8e0',
      blue:         '--accent',
      brightBlue:   '#60a5fa',
      magenta:      '#a855f7',
      brightMagenta:'#c084fc',
      white:        '#c8c8e0',
      brightWhite:  '#e8e8ff',
    },
  },
  phyrexian: {
    label: 'Phyrexian (Iridescent)',
    colors: {
      '--bg':          '#0a0810',
      '--bg-card':     '#100e18',
      '--bg-header':   '#0c0a14',
      '--bg-surface':  '#16122a',
      '--border':      '#2a2440',
      '--border-dim':  '#1e1a32',
      '--border-hover':'#3e3660',
      '--text':        '#c8c0e0',
      '--text-dim':    '#8d82b9',
      '--text-head':   '#e8e0ff',
      '--text-muted':  '#8579b1',
      '--accent':      '#c084fc',
      '--accent-dim':  '#9656d6',

      ...BASE_STATE_COLORS,
      '--state-monitoring':   '#60a5fa',
      '--state-monitoring-bg': 'rgba(96, 165, 250, 0.08)',
      '--state-done':         '#67e8f9',
      '--state-done-bg':      'rgba(103, 232, 249, 0.06)',
      '--state-starting':     '#f472b6',
      '--state-starting-bg':  'rgba(244, 114, 182, 0.06)',
      '--state-complete':     '#34d399',
      '--state-complete-bg':  'rgba(52, 211, 153, 0.06)',
    },
    terminal: {
      ...BASE_TERMINAL,
      foreground:   '#c8c0e0',
      blue:         '#67e8f9',
      brightBlue:   '#a5f3fc',
      magenta:      '--accent',
      brightMagenta:'#d8b4fe',
      white:        '#c8c0e0',
      brightWhite:  '#e8e0ff',
    },
  },
  compleated: {
    label: 'Compleated (Light)',
    colors: {
      '--bg':          '#ece8e0',
      '--bg-card':     '#f7f4ee',
      '--bg-header':   '#f0ece4',
      '--bg-surface':  '#e4e0d6',
      '--border':      '#b8b0a0',
      '--border-dim':  '#ccc6b8',
      '--border-hover':'#908878',
      '--text':        '#2a2622',
      '--text-dim':    '#5a5448',
      '--text-head':   '#0e0c0a',
      '--text-muted':  '#676157',
      '--accent':      '#0e0c0a',
      '--accent-dim':  '#2a2622',

      '--state-running':      '#16803c',
      '--state-running-bg':   'rgba(22, 128, 60, 0.08)',
      '--state-waiting':      '#b45309',
      '--state-waiting-bg':   'rgba(180, 83, 9, 0.08)',
      '--state-failed':       '#dc2626',
      '--state-failed-bg':    'rgba(220, 38, 38, 0.06)',
      '--state-monitoring':   '#0e7490',
      '--state-monitoring-bg': 'rgba(14, 116, 144, 0.08)',
      '--state-done':         '#1a1816',
      '--state-done-bg':      'rgba(26, 24, 22, 0.06)',
      '--state-initializing': '#6b7280',
      '--state-initializing-bg': 'rgba(107, 114, 128, 0.06)',
      '--state-idle':         '#a16207',
      '--state-idle-bg':      'rgba(161, 98, 7, 0.06)',
      '--state-starting':     '#7c3aed',
      '--state-starting-bg':  'rgba(124, 58, 237, 0.06)',
      '--state-complete':     '#059669',
      '--state-complete-bg':  'rgba(5, 150, 105, 0.06)',
    },
    terminal: {
      background:   '#faf8f4',
      foreground:   '#1a1816',
      cursor:       '#1a1816',
      cursorAccent: '#faf8f4',
      black:        '#1a1816',
      brightBlack:  '#5a5448',
      red:          '#b91c1c',
      brightRed:    '#dc2626',
      green:        '#15803d',
      brightGreen:  '#16a34a',
      yellow:       '#92400e',
      brightYellow: '#a16207',
      blue:         '#1d4ed8',
      brightBlue:   '#2563eb',
      magenta:      '#6d28d9',
      brightMagenta:'#7c3aed',
      cyan:         '#0e7490',
      brightCyan:   '#0891b2',
      white:        '#5a5448',
      brightWhite:  '#3a3630',
    },
  },
  unicorn: {
    label: 'Rainbow Unicorns (Dark)',
    colors: {
      '--bg':          '#191022',
      '--bg-card':     '#201730',
      '--bg-header':   '#1c1329',
      '--bg-surface':  '#281c3c',
      '--border':      '#3a2c52',
      '--border-dim':  '#2a2040',
      '--border-hover':'#55407a',
      '--text':        '#d4c8e6',
      '--text-dim':    '#9a88b8',
      '--text-head':   '#ede4fa',
      '--text-muted':  '#a897c4',
      '--accent':      '#e8a3c4',
      '--accent-dim':  '#c4739e',

      '--state-running':      '#42d780',
      '--state-running-bg':   'rgba(66, 215, 128, 0.10)',
      '--state-waiting':      '#f79f3b',
      '--state-waiting-bg':   'rgba(247, 159, 59, 0.10)',
      '--state-failed':       '#f05442',
      '--state-failed-bg':    'rgba(240, 84, 66, 0.13)',
      '--state-monitoring':   '#2dd4bf',
      '--state-monitoring-bg': 'rgba(45, 212, 191, 0.08)',
      '--state-done':         '#f04ca4',
      '--state-done-bg':      'rgba(240, 76, 164, 0.13)',
      '--state-initializing': '#8f87a6',
      '--state-initializing-bg': 'rgba(143, 135, 166, 0.08)',
      '--state-idle':         '#bcb02f',
      '--state-idle-bg':      'rgba(188, 176, 47, 0.08)',
      '--state-starting':     '#a17ef1',
      '--state-starting-bg':  'rgba(161, 126, 241, 0.08)',
      '--state-complete':     '#34baf4',
      '--state-complete-bg':  'rgba(52, 186, 244, 0.14)',
    },
    terminal: {
      background:   '#201730',
      foreground:   '#d4c8e6',
      cursor:       '--accent',
      cursorAccent: '#201730',
      black:        '#8c7dab',
      brightBlack:  '#9c8fb5',
      red:          '#e8887e',
      brightRed:    '#f4a89f',
      green:        '#86e0ab',
      brightGreen:  '#a3edc0',
      yellow:       '#f0c674',
      brightYellow: '#f5d896',
      blue:         '#9cb3f0',
      brightBlue:   '#b5c8f5',
      magenta:      '#dd8ecf',
      brightMagenta:'#e6a8dc',
      cyan:         '#7fd4d0',
      brightCyan:   '#a0e6e2',
      white:        '#d4c8e6',
      brightWhite:  '#f4ecfc',
    },
  },
  'posthog-light': {
    label: 'PostHog (Light)',
    colors: {
      '--bg':          '#eeefe9',
      '--bg-card':     '#fdfdf8',
      '--bg-header':   '#eeefe9',
      '--bg-surface':  '#e5e7e0',
      '--border':      '#bfc1b7',
      '--border-dim':  '#d2d3cc',
      '--border-hover':'#9ea096',
      '--text':        '#23251d',
      '--text-dim':    '#65675e',
      '--text-head':   '#111111',
      '--text-muted':  '#73756b',
      '--accent':      '#c03300',
      '--accent-dim':  '#8e2600',

      '--state-running':      '#4d7533',
      '--state-running-bg':   'rgba(77, 117, 51, 0.08)',
      '--state-waiting':      '#b17816',
      '--state-waiting-bg':   'rgba(177, 120, 22, 0.10)',
      '--state-failed':       '#8c0d3b',
      '--state-failed-bg':    'rgba(140, 13, 59, 0.07)',
      '--state-monitoring':   '#0e7490',
      '--state-monitoring-bg': 'rgba(14, 116, 144, 0.08)',
      '--state-done':         '#3e6b9e',
      '--state-done-bg':      'rgba(62, 107, 158, 0.08)',
      '--state-initializing': '#73756b',
      '--state-initializing-bg': 'rgba(115, 117, 107, 0.07)',
      '--state-idle':         '#835c19',
      '--state-idle-bg':      'rgba(131, 92, 25, 0.07)',
      '--state-starting':     '#a621c8',
      '--state-starting-bg':  'rgba(166, 33, 200, 0.07)',
      '--state-complete':     '#34796f',
      '--state-complete-bg':  'rgba(52, 121, 111, 0.08)',
    },
    terminal: {
      background:   '--bg-card',
      foreground:   '#23251d',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      black:        '#23251d',
      brightBlack:  '#65675e',
      red:          '#c03300',
      brightRed:    '#df6133',
      green:        '#4d7533',
      brightGreen:  '#6aa84f',
      yellow:       '#835c19',
      brightYellow: '#b17816',
      blue:         '#3e6b9e',
      brightBlue:   '#2f80fa',
      magenta:      '#74108d',
      brightMagenta:'#a621c8',
      cyan:         '#34796f',
      brightCyan:   '#30abc6',
      white:        '#4d4f46',
      brightWhite:  '#23251d',
    },
  },
  'posthog-dark': {
    label: 'PostHog (Dark)',
    colors: {
      '--bg':          '#1e1f23',
      '--bg-card':     '#25262b',
      '--bg-header':   '#232429',
      '--bg-surface':  '#2d2e37',
      '--border':      '#3e424f',
      '--border-dim':  '#32343f',
      '--border-hover':'#626674',
      '--text':        '#edeef4',
      '--text-dim':    '#aeb3c2',
      '--text-head':   '#fafafa',
      '--text-muted':  '#9ea096',
      '--accent':      '#f87a4c',
      '--accent-dim':  '#f54e00',

      '--state-running':      '#36c46f',
      '--state-running-bg':   'rgba(54, 196, 111, 0.08)',
      '--state-waiting':      '#f7a501',
      '--state-waiting-bg':   'rgba(247, 165, 1, 0.09)',
      '--state-failed':       '#f35454',
      '--state-failed-bg':    'rgba(243, 84, 84, 0.09)',
      '--state-monitoring':   '#22d3ee',
      '--state-monitoring-bg': 'rgba(34, 211, 238, 0.08)',
      '--state-done':         '#589df8',
      '--state-done-bg':      'rgba(88, 157, 248, 0.08)',
      '--state-initializing': '#8f8f8c',
      '--state-initializing-bg': 'rgba(143, 143, 140, 0.07)',
      '--state-idle':         '#ffce5c',
      '--state-idle-bg':      'rgba(255, 206, 92, 0.07)',
      '--state-starting':     '#8567ff',
      '--state-starting-bg':  'rgba(133, 103, 255, 0.09)',
      '--state-complete':     '#29dbbb',
      '--state-complete-bg':  'rgba(41, 219, 187, 0.08)',
    },
    terminal: {
      background:   '--bg-card',
      foreground:   '#edeef4',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      black:        '--border',
      brightBlack:  '--text-muted',
      red:          '#f35454',
      brightRed:    '#f87a4c',
      green:        '#36c46f',
      brightGreen:  '#96e5b6',
      yellow:       '#f7a501',
      brightYellow: '#ffce5c',
      blue:         '#2f80fa',
      brightBlue:   '#9fc4ff',
      magenta:      '#8567ff',
      brightMagenta:'#e2d6ff',
      cyan:         '#30abc6',
      brightCyan:   '#29dbbb',
      white:        '#aeb3c2',
      brightWhite:  '#fafafa',
    },
  },
};

const DEFAULT_THEME = 'phyrexian';

let _currentThemeId: string | null = null;

export function applyTheme(themeId: string) {
  const theme = THEMES[themeId];
  if (!theme) return;

  const prev = _currentThemeId;
  _currentThemeId = themeId;
  const root = document.documentElement;
  root.dataset.theme = themeId;
  for (const [prop, value] of Object.entries(theme.colors)) {
    root.style.setProperty(prop, value);
  }

  if (themeId !== 'unicorn') return;
  if (prev === null || prev === 'unicorn') return;
  playNyanJingle();
}

export function applyCompactStatusLabels(isEnabled: boolean) {
  document.documentElement.toggleAttribute('data-compact-status', isEnabled);
}

export function applySessionUsageChips(isShown: boolean) {
  document.documentElement.toggleAttribute('data-show-usage', isShown);
}

export function getTerminalTheme(): Record<string, string> {
  const theme = THEMES[_currentThemeId || DEFAULT_THEME];
  if (!theme) return {};

  const style = getComputedStyle(document.documentElement);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.terminal)) {
    result[key] = value.startsWith('--') ? style.getPropertyValue(value).trim() : value;
  }
  return result;
}

export function getThemeList(): { id: string; label: string }[] {
  return Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label }));
}

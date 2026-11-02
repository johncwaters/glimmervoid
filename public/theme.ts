type ThemeMode = 'dark' | 'light';
type AccentAnsiSlot = 'blue' | 'magenta' | 'none';

const STATE_NAMES = ['running', 'waiting', 'failed', 'monitoring', 'done', 'initializing', 'idle', 'starting', 'complete'] as const;
type StateName = (typeof STATE_NAMES)[number];

type ChromeToken =
  | 'bg' | 'bg-card' | 'bg-header' | 'bg-surface'
  | 'border' | 'border-dim' | 'border-hover'
  | 'text' | 'text-dim' | 'text-head' | 'text-muted'
  | 'accent' | 'accent-dim';

interface ThemePalette {
  label: string;
  mode: ThemeMode;
  accentAnsiSlot: AccentAnsiSlot;
  chrome: Record<ChromeToken, string>;
  states: Record<StateName, string>;
}

interface ThemeDefinition {
  label: string;
  colors: Record<string, string>;
  terminal: Record<string, string>;
}

const STRONG_TINT_STATES: ReadonlySet<StateName> = new Set(['waiting', 'monitoring']);

const ANSI_HUES_BY_MODE: Record<ThemeMode, Record<string, string>> = {
  dark: {
    red:          '#ef4444',
    brightRed:    '#f87171',
    green:        '#22c55e',
    brightGreen:  '#4ade80',
    yellow:       '#eab308',
    brightYellow: '#facc15',
    blue:         '#3b82f6',
    brightBlue:   '#60a5fa',
    magenta:      '#a855f7',
    brightMagenta:'#c084fc',
    cyan:         '#06b6d4',
    brightCyan:   '#22d3ee',
  },
  light: {
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
  },
};

const ANSI_NEUTRALS_BY_MODE: Record<ThemeMode, Record<string, string>> = {
  dark: {
    black:       '--border',
    brightBlack: '--text-muted',
    white:       '--text',
    brightWhite: '--text-head',
  },
  light: {
    black:       '--text-head',
    brightBlack: '--text-dim',
    white:       '--text-dim',
    brightWhite: '--text',
  },
};

const BRIGHT_ACCENT_WHITE_SHARE = 0.35;

function mixTowardWhite(hexColor: string, whiteShare: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hexColor.slice(offset, offset + 2), 16));
  const mixedChannels = channels.map((channel) => Math.round(channel + (255 - channel) * whiteShare));
  return `#${mixedChannels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function buildStateColors(states: Record<StateName, string>): Record<string, string> {
  const stateColors: Record<string, string> = {};
  for (const stateName of STATE_NAMES) {
    const tintPercent = STRONG_TINT_STATES.has(stateName) ? 8 : 6;
    stateColors[`--state-${stateName}`] = states[stateName];
    stateColors[`--state-${stateName}-bg`] = `color-mix(in oklab, var(--state-${stateName}) ${tintPercent}%, transparent)`;
  }
  return stateColors;
}

function buildAccentAnsi(palette: ThemePalette): Record<string, string> {
  if (palette.accentAnsiSlot === 'none') return {};
  const brightSlot = `bright${palette.accentAnsiSlot[0].toUpperCase()}${palette.accentAnsiSlot.slice(1)}`;
  return {
    [palette.accentAnsiSlot]: '--accent',
    [brightSlot]: mixTowardWhite(palette.chrome.accent, BRIGHT_ACCENT_WHITE_SHARE),
  };
}

function defineTheme(palette: ThemePalette): ThemeDefinition {
  const chromeColors = Object.fromEntries(Object.entries(palette.chrome).map(([token, color]) => [`--${token}`, color]));
  return {
    label: palette.label,
    colors: { ...chromeColors, ...buildStateColors(palette.states) },
    terminal: {
      background:   '--bg-card',
      foreground:   '--text',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      ...ANSI_NEUTRALS_BY_MODE[palette.mode],
      ...ANSI_HUES_BY_MODE[palette.mode],
      ...buildAccentAnsi(palette),
    },
  };
}

const THEMES: Record<string, ThemeDefinition> = {
  golgari: defineTheme({
    label: 'Golgari (Dark)',
    mode: 'dark',
    accentAnsiSlot: 'blue',
    chrome: {
      'bg':           '#060b08',
      'bg-card':      '#0a120e',
      'bg-header':    '#081009',
      'bg-surface':   '#0e1a12',
      'border':       '#1a2e1f',
      'border-dim':   '#122016',
      'border-hover': '#2a4a32',
      'text':         '#b8ccbe',
      'text-dim':     '#6a9070',
      'text-head':    '#dceede',
      'text-muted':   '#7a9a80',
      'accent':       '#2dd4a0',
      'accent-dim':   '#1a9a6e',
    },
    states: {
      running:      '#22c55e',
      waiting:      '#f59e0b',
      failed:       '#ef4444',
      monitoring:   '#22d3ee',
      done:         '#94a3b8',
      initializing: '#6b7280',
      idle:         '#eab308',
      starting:     '#a78bfa',
      complete:     '#34d399',
    },
  }),
  midnight: defineTheme({
    label: 'Midnight (Dark)',
    mode: 'dark',
    accentAnsiSlot: 'blue',
    chrome: {
      'bg':           '#080816',
      'bg-card':      '#0e0e20',
      'bg-header':    '#0b0b1a',
      'bg-surface':   '#131328',
      'border':       '#1c1c38',
      'border-dim':   '#141430',
      'border-hover': '#2a2a50',
      'text':         '#b8b8d4',
      'text-dim':     '#8585b3',
      'text-head':    '#dcdcf0',
      'text-muted':   '#7c7ca9',
      'accent':       '#5674f7',
      'accent-dim':   '#3a54c0',
    },
    states: {
      running:      '#22c55e',
      waiting:      '#f59e0b',
      failed:       '#ef4444',
      monitoring:   '#22d3ee',
      done:         '#94a3b8',
      initializing: '#6b7280',
      idle:         '#eab308',
      starting:     '#a855f7',
      complete:     '#60a5fa',
    },
  }),
  phyrexian: defineTheme({
    label: 'Phyrexian (Dark)',
    mode: 'dark',
    accentAnsiSlot: 'magenta',
    chrome: {
      'bg':           '#0a0810',
      'bg-card':      '#100e18',
      'bg-header':    '#0c0a14',
      'bg-surface':   '#16122a',
      'border':       '#2a2440',
      'border-dim':   '#1e1a32',
      'border-hover': '#3e3660',
      'text':         '#c8c0e0',
      'text-dim':     '#8d82b9',
      'text-head':    '#e8e0ff',
      'text-muted':   '#8579b1',
      'accent':       '#c084fc',
      'accent-dim':   '#9656d6',
    },
    states: {
      running:      '#22c55e',
      waiting:      '#f59e0b',
      failed:       '#ef4444',
      monitoring:   '#60a5fa',
      done:         '#67e8f9',
      initializing: '#6b7280',
      idle:         '#eab308',
      starting:     '#f472b6',
      complete:     '#34d399',
    },
  }),
  compleated: defineTheme({
    label: 'Compleated (Light)',
    mode: 'light',
    accentAnsiSlot: 'none',
    chrome: {
      'bg':           '#ece8e0',
      'bg-card':      '#f7f4ee',
      'bg-header':    '#f0ece4',
      'bg-surface':   '#e4e0d6',
      'border':       '#b8b0a0',
      'border-dim':   '#ccc6b8',
      'border-hover': '#908878',
      'text':         '#2a2622',
      'text-dim':     '#5a5448',
      'text-head':    '#0e0c0a',
      'text-muted':   '#676157',
      'accent':       '#0e0c0a',
      'accent-dim':   '#2a2622',
    },
    states: {
      running:      '#157838',
      waiting:      '#a94e08',
      failed:       '#cd2323',
      monitoring:   '#0e728d',
      done:         '#5a697e',
      initializing: '#6b7280',
      idle:         '#995d07',
      starting:     '#7c3aed',
      complete:     '#047a55',
    },
  }),
  unicorn: defineTheme({
    label: 'Rainbow Unicorns (Dark)',
    mode: 'dark',
    accentAnsiSlot: 'magenta',
    chrome: {
      'bg':           '#191022',
      'bg-card':      '#201730',
      'bg-header':    '#1c1329',
      'bg-surface':   '#281c3c',
      'border':       '#3a2c52',
      'border-dim':   '#2a2040',
      'border-hover': '#55407a',
      'text':         '#d4c8e6',
      'text-dim':     '#9a88b8',
      'text-head':    '#ede4fa',
      'text-muted':   '#a897c4',
      'accent':       '#e8a3c4',
      'accent-dim':   '#c4739e',
    },
    states: {
      running:      '#42d780',
      waiting:      '#f79f3b',
      failed:       '#f15e4d',
      monitoring:   '#2dd4bf',
      done:         '#f153a8',
      initializing: '#8f87a6',
      idle:         '#bcb02f',
      starting:     '#a17ef1',
      complete:     '#34baf4',
    },
  }),
  'posthog-light': defineTheme({
    label: 'PostHog (Light)',
    mode: 'light',
    accentAnsiSlot: 'none',
    chrome: {
      'bg':           '#eeefe9',
      'bg-card':      '#fdfdf8',
      'bg-header':    '#eeefe9',
      'bg-surface':   '#e5e7e0',
      'border':       '#bfc1b7',
      'border-dim':   '#d2d3cc',
      'border-hover': '#9ea096',
      'text':         '#23251d',
      'text-dim':     '#65675e',
      'text-head':    '#111111',
      'text-muted':   '#66685f',
      'accent':       '#c03300',
      'accent-dim':   '#8e2600',
    },
    states: {
      running:      '#237a36',
      waiting:      '#936412',
      failed:       '#8c0d3b',
      monitoring:   '#0e7490',
      done:         '#3e6b9e',
      initializing: '#73756b',
      idle:         '#835c19',
      starting:     '#a621c8',
      complete:     '#34796f',
    },
  }),
  'posthog-dark': defineTheme({
    label: 'PostHog (Dark)',
    mode: 'dark',
    accentAnsiSlot: 'none',
    chrome: {
      'bg':           '#1e1f23',
      'bg-card':      '#25262b',
      'bg-header':    '#232429',
      'bg-surface':   '#2d2e37',
      'border':       '#3e424f',
      'border-dim':   '#32343f',
      'border-hover': '#626674',
      'text':         '#edeef4',
      'text-dim':     '#aeb3c2',
      'text-head':    '#fafafa',
      'text-muted':   '#9ea096',
      'accent':       '#f87a4c',
      'accent-dim':   '#f54e00',
    },
    states: {
      running:      '#36c46f',
      waiting:      '#f7a501',
      failed:       '#f46767',
      monitoring:   '#22d3ee',
      done:         '#589df8',
      initializing: '#8f8f8c',
      idle:         '#ffce5c',
      starting:     '#9a81ff',
      complete:     '#29dbbb',
    },
  }),
};

const DEFAULT_THEME = 'phyrexian';

let unicornThemeEnteredListener: (() => void) | null = null;
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
  unicornThemeEnteredListener?.();
}

export function onUnicornThemeEntered(listener: () => void) {
  unicornThemeEnteredListener = listener;
}

export function applySessionUsageChips(isShown: boolean) {
  document.documentElement.toggleAttribute('data-show-usage', isShown);
}

export function applyPhoneArrowPad(isEnabled: boolean) {
  document.documentElement.toggleAttribute('data-arrow-pad', isEnabled);
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

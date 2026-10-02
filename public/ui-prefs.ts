import { FLYING_ANIMALS_DEFAULTS, normalizeExcludedSprites, normalizeFlyingAnimalsOptions } from './flying-animals-core.ts';
import type { FlyingAnimalsOptions } from './flying-animals-core.ts';
import { DEFAULT_SOUND_ID } from './alert-sound-core.ts';
import { getJSON, setJSON } from './local-store.ts';

const STORAGE_KEY = 'glimmervoid-ui-prefs';
const SIDEBAR_WIDTH_KEY = 'glimmervoid:sidebar-width';

export interface UiPrefs extends FlyingAnimalsOptions {
  soundEnabled: boolean;
  soundId: string;
  themeId: string;
  flyingAnimalsEnabled: boolean;
  notificationsEnabled: boolean;
  compactStatusLabels: boolean;
  activeView: string;
  lastFocusedSessionId: string | null;
  railWidth: number | null;
  reviewSidebarExpanded: boolean;
  reviewSidebarView: 'map' | 'diff' | 'notes';
  prsQueueWidth: number | null;
  prsQueueCollapsed: boolean;
  prsMode: 'team' | 'mine';
  keptProjects: string[];
  traceHiddenKinds: string[];
  dismissedUpdate: string | null;
  telemetryNoticeDismissed: boolean;
  radarAttentionAck: string;
  prsAttentionAck: string;
  usageAttentionAck: string;
  visionsAttentionAck: string;
}

const asBoolean = (fallback: boolean) => (value: unknown): boolean => (typeof value === 'boolean' ? value : fallback);
const asString = (fallback: string) => (value: unknown): string => (typeof value === 'string' ? value : fallback);
const asNullableString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const asNullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asFiniteNumber = (fallback: number) => (value: unknown): number => asNullableNumber(value) ?? fallback;
const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))] : [];
const asReviewSidebarView = (value: unknown): UiPrefs['reviewSidebarView'] => value === 'diff' || value === 'notes' ? value : 'map';
const asPrsMode = (value: unknown): UiPrefs['prsMode'] => value === 'mine' ? 'mine' : 'team';

const PREFS: { [Key in keyof UiPrefs]: (value: unknown) => UiPrefs[Key] } = {
  soundEnabled: asBoolean(true),
  soundId: asString(DEFAULT_SOUND_ID),
  themeId: asString('phyrexian'),
  flyingAnimalsEnabled: asBoolean(false),
  flyingAnimalsMinGapSeconds: asFiniteNumber(FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinGapSeconds),
  flyingAnimalsMaxGapSeconds: asFiniteNumber(FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxGapSeconds),
  flyingAnimalsMinDurationSeconds: asFiniteNumber(FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinDurationSeconds),
  flyingAnimalsMaxDurationSeconds: asFiniteNumber(FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxDurationSeconds),
  flyingAnimalsScale: asFiniteNumber(FLYING_ANIMALS_DEFAULTS.flyingAnimalsScale),
  flyingAnimalsOnPhone: asBoolean(FLYING_ANIMALS_DEFAULTS.flyingAnimalsOnPhone),
  flyingAnimalsExcludedSprites: normalizeExcludedSprites,
  notificationsEnabled: asBoolean(true),
  compactStatusLabels: asBoolean(false),
  activeView: asString('focus'),
  lastFocusedSessionId: asNullableString,
  railWidth: asNullableNumber,
  reviewSidebarExpanded: asBoolean(false),
  reviewSidebarView: asReviewSidebarView,
  prsQueueWidth: asNullableNumber,
  prsQueueCollapsed: asBoolean(false),
  prsMode: asPrsMode,
  keptProjects: asStringList,
  traceHiddenKinds: asStringList,
  dismissedUpdate: asNullableString,
  telemetryNoticeDismissed: asBoolean(false),
  radarAttentionAck: asString(''),
  prsAttentionAck: asString(''),
  usageAttentionAck: asString(''),
  visionsAttentionAck: asString(''),
};

function normalizeInto<Key extends keyof UiPrefs>(prefs: Partial<UiPrefs>, key: Key, raw: unknown) {
  prefs[key] = PREFS[key](raw);
}

function load(): UiPrefs {
  const stored = getJSON<Record<string, unknown>>(STORAGE_KEY, {});
  const prefs: Partial<UiPrefs> = {};
  for (const key of Object.keys(PREFS) as (keyof UiPrefs)[]) normalizeInto(prefs, key, stored?.[key]);
  return prefs as UiPrefs;
}

function read<Key extends keyof UiPrefs>(key: Key): UiPrefs[Key] {
  return load()[key];
}

function write<Key extends keyof UiPrefs>(key: Key, value: unknown) {
  const prefs = load();
  normalizeInto(prefs, key, value);
  setJSON(STORAGE_KEY, prefs);
}

export const isSoundEnabled = () => read('soundEnabled');
export const setSoundEnabled = (enabled: boolean) => write('soundEnabled', enabled);

export const getSoundId = () => read('soundId');
export const setSoundId = (id: string) => write('soundId', id);

export const isNotificationsEnabled = () => read('notificationsEnabled');
export const setNotificationsEnabled = (enabled: boolean) => write('notificationsEnabled', enabled);

export const isCompactStatusLabels = () => read('compactStatusLabels');
export const setCompactStatusLabels = (enabled: boolean) => write('compactStatusLabels', enabled);

export const getThemeId = () => read('themeId');
export const setThemeId = (id: string) => write('themeId', id);

export const isFlyingAnimalsEnabled = () => read('flyingAnimalsEnabled');
export const setFlyingAnimalsEnabled = (enabled: boolean) => write('flyingAnimalsEnabled', enabled);

export const getActiveView = () => read('activeView');
export const setActiveView = (view: string) => write('activeView', view);

export const getRailWidth = () => read('railWidth');
export const setRailWidth = (px: number | null) => write('railWidth', px);

export const isReviewSidebarExpanded = () => read('reviewSidebarExpanded');
export const setReviewSidebarExpanded = (expanded: boolean) => write('reviewSidebarExpanded', expanded);
export const getReviewSidebarView = () => read('reviewSidebarView');
export const setReviewSidebarView = (view: UiPrefs['reviewSidebarView']) => write('reviewSidebarView', view);

export const getPrsQueueWidth = () => read('prsQueueWidth');
export const setPrsQueueWidth = (px: number | null) => write('prsQueueWidth', px);
export const isPrsQueueCollapsed = () => read('prsQueueCollapsed');
export const setPrsQueueCollapsed = (collapsed: boolean) => write('prsQueueCollapsed', collapsed);
export const getPrsMode = () => read('prsMode');
export const setPrsMode = (mode: UiPrefs['prsMode']) => write('prsMode', mode);

export const getKeptProjects = () => read('keptProjects');
export const setKeptProjects = (paths: string[]) => write('keptProjects', paths);

export const getTraceHiddenKinds = () => read('traceHiddenKinds');
export const setTraceHiddenKinds = (kinds: string[]) => write('traceHiddenKinds', kinds);

export const getDismissedUpdate = () => read('dismissedUpdate');
export const setDismissedUpdate = (key: string | null) => write('dismissedUpdate', key);

export const isTelemetryNoticeDismissed = () => read('telemetryNoticeDismissed');
export const setTelemetryNoticeDismissed = (dismissed: boolean) => write('telemetryNoticeDismissed', dismissed);

export const getRadarAttentionAck = () => read('radarAttentionAck');
export const setRadarAttentionAck = (signature: string) => write('radarAttentionAck', signature);

export const getPrsAttentionAck = () => read('prsAttentionAck');
export const setPrsAttentionAck = (signature: string) => write('prsAttentionAck', signature);

export const getUsageAttentionAck = () => read('usageAttentionAck');
export const setUsageAttentionAck = (signature: string) => write('usageAttentionAck', signature);

export const getVisionsAttentionAck = () => read('visionsAttentionAck');
export const setVisionsAttentionAck = (signature: string) => write('visionsAttentionAck', signature);

export const getLastFocusedSessionId = () => read('lastFocusedSessionId');
export const setLastFocusedSessionId = (id: string | null) => write('lastFocusedSessionId', id);

export const getSidebarWidth = () => asNullableNumber(getJSON(SIDEBAR_WIDTH_KEY, null));
export const setSidebarWidth = (px: number | null) => setJSON(SIDEBAR_WIDTH_KEY, asNullableNumber(px));

export const setFlyingAnimalsMinGapSeconds = (value: number) => write('flyingAnimalsMinGapSeconds', value);

export const setFlyingAnimalsMaxGapSeconds = (value: number) => write('flyingAnimalsMaxGapSeconds', value);

export const setFlyingAnimalsMinDurationSeconds = (value: number) => write('flyingAnimalsMinDurationSeconds', value);

export const setFlyingAnimalsMaxDurationSeconds = (value: number) => write('flyingAnimalsMaxDurationSeconds', value);

export const setFlyingAnimalsScale = (value: number) => write('flyingAnimalsScale', value);

export const setFlyingAnimalsOnPhone = (value: boolean) => write('flyingAnimalsOnPhone', value);

export const setFlyingAnimalsExcludedSprites = (value: string[]) => write('flyingAnimalsExcludedSprites', value);

export const getFlyingAnimalsOptions = () => normalizeFlyingAnimalsOptions(load());

export const getFlyingAnimalsEnteredValues = () => {
  const prefs = load();
  return Object.fromEntries((Object.keys(FLYING_ANIMALS_DEFAULTS) as (keyof typeof FLYING_ANIMALS_DEFAULTS)[]).map((key) => [key, prefs[key]]));
};

export const resetFlyingAnimalsAdvanced = () => setJSON(STORAGE_KEY, { ...load(), ...FLYING_ANIMALS_DEFAULTS });

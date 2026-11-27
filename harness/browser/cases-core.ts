import { PHONE_MAX_WIDTH_PX, decideLayout } from '../../public/form-factor-core.ts';

export type ViewerId = 'a' | 'b';



export type Step =
  | { kind: 'assert-undo-close'; viewer?: ViewerId }
  | { kind: 'assert-solid-hello'; viewer?: ViewerId }
  | { kind: 'assert-solid-island'; viewer?: ViewerId }
  | { kind: 'assert-solid-store-signal'; viewer?: ViewerId }
  | { kind: 'assert-state-core'; viewer?: ViewerId }
  | { kind: 'assert-ui-primitives-parity'; viewer?: ViewerId }
  | { kind: 'assert-confirm-dialog'; viewer?: ViewerId }
  | { kind: 'assert-added-session-shown'; viewer?: ViewerId }
  | { kind: 'assert-boards'; viewer?: ViewerId }
  | { kind: 'assert-board-pane'; viewer?: ViewerId }
  | { kind: 'assert-rail-drag'; viewer?: ViewerId }
  | { kind: 'assert-board-scale'; viewer?: ViewerId }
  | { kind: 'assert-team-review'; viewer?: ViewerId }
  | { kind: 'assert-review-changes'; viewer?: ViewerId }
  | { kind: 'assert-chat-approvals'; viewer?: ViewerId }
  | { kind: 'assert-chat-done-means'; viewer?: ViewerId }
  | { kind: 'assert-chat-terminal'; viewer?: ViewerId }
  | { kind: 'assert-chat-plan'; viewer?: ViewerId }
  | { kind: 'assert-chat-elicitation'; viewer?: ViewerId }
  | { kind: 'assert-board-session'; viewer?: ViewerId }
  | { kind: 'assert-chat-sign-in'; viewer?: ViewerId }
  | { kind: 'assert-chat-usage-limit'; viewer?: ViewerId }
  | { kind: 'assert-chat-away-reply'; viewer?: ViewerId }
  | { kind: 'assert-chat-default'; viewer?: ViewerId }
  | { kind: 'assert-chat-default-phone'; viewer?: ViewerId }
  | { kind: 'assert-phone-changes'; viewer?: ViewerId }
  | { kind: 'assert-key-strip-contexts'; viewer?: ViewerId }
  | { kind: 'assert-fullscreen-app-row'; viewer?: ViewerId }
  | { kind: 'assert-terminal-typing'; viewer?: ViewerId }
  | { kind: 'search-terminal-typing'; viewer?: ViewerId }
  | { kind: 'assert-touch-select-copy'; viewer?: ViewerId }
  | { kind: 'assert-link-repaint'; viewer?: ViewerId }
  | { kind: 'open'; viewer?: ViewerId }
  | { kind: 'back'; viewer?: ViewerId }
  | { kind: 'assert-settings-back'; viewer?: ViewerId }
  | { kind: 'resize'; width: number; height: number; viewer?: ViewerId }
  | { kind: 'resize-by'; deltaWidth?: number; deltaHeight?: number; viewer?: ViewerId }
  | { kind: 'keyboard'; state: 'up' | 'down'; viewer?: ViewerId }
  | { kind: 'type'; text: string; viewer?: ViewerId }
  | { kind: 'burst'; lines: number; viewer?: ViewerId }
  | { kind: 'offline'; viewer?: ViewerId }
  | { kind: 'online'; viewer?: ViewerId }
  | { kind: 'foreground'; quiet?: boolean; viewer?: ViewerId }
  | { kind: 'wait'; durationMs: number; viewer?: ViewerId }
  | { kind: 'background'; quiet?: boolean; viewer?: ViewerId }
  | { kind: 'suspend'; viewer?: ViewerId }
  | { kind: 'window-blur'; viewer?: ViewerId }
  | { kind: 'tap-terminal'; viewer?: ViewerId }
  | { kind: 'remember'; label: string; viewer?: ViewerId }
  | { kind: 'settle'; viewer?: ViewerId; expectGrid?: 'exact' | 'following'; expectRemembered?: string }
  | { kind: 'assert-grid'; viewer?: ViewerId; tickOffset?: number }
  | { kind: 'assert-fit'; viewer?: ViewerId }
  | { kind: 'touch-scroll'; viewer?: ViewerId }
  | { kind: 'fit-measurement'; available: boolean; viewer?: ViewerId }
  | { kind: 'expect-link'; value: 'live' | 'connecting'; viewer?: ViewerId }
  | { kind: 'watch-terminal'; viewer?: ViewerId }
  | { kind: 'expect-terminal-untouched'; durationMs: number; viewer?: ViewerId }
  | { kind: 'expect-revealed'; viewer?: ViewerId }
  | { kind: 'load-deep-history'; viewer?: ViewerId }
  | { kind: 'rename-session'; newName: string; viewer?: ViewerId }
  | { kind: 'remove-session'; viewer?: ViewerId }
  | { kind: 'remove-from-phone-terminal'; viewer?: ViewerId }
  | { kind: 'expect-session-gone'; viewer?: ViewerId }
  | { kind: 'expect-session-name'; name: string; viewer?: ViewerId }
  | { kind: 'shot'; name: string; viewer?: ViewerId };

export type ResolvedStep = Exclude<Step, { kind: 'resize-by' }>;

export interface Viewport {
  name: string;
  width: number;
  height: number;
  hasTouch: boolean;
  isMobile: boolean;
  keyboardHeight?: number;
}

export type Layout = 'phone' | 'desktop';

export interface Scenario {
  name: string;
  steps: readonly Step[];
  phoneOnly?: boolean;
  fullMatrix?: boolean;
  optional?: boolean;
  companionViewport?: string;
  viewports?: readonly string[];
  proveFailure?: boolean;
  runsOnlyWhenNamed?: boolean;
  agent?: string;
  skipsPermissions?: boolean;
  projectSeed?: string;
}

export interface ResolvedScenario extends Omit<Scenario, 'steps'> {
  steps: readonly ResolvedStep[];
}

export interface HarnessCase {
  viewport: Viewport;
  scenario: ResolvedScenario;
  expectedLayout: Layout;
  companion: Viewport | null;
}

export interface CasesForOptions {
  only?: readonly string[];
  viewportNames?: readonly string[];
  proveFailure?: boolean;
}

export const MIN_VIEWPORT_WIDTH_PX = 320;
export const MAX_VIEWPORT_WIDTH_PX = 1920;
export const MIN_VIEWPORT_HEIGHT_PX = 300;
export const MAX_VIEWPORT_HEIGHT_PX = 1200;

export const VIEWPORTS: readonly Viewport[] = [
  { name: 'phone-375', width: 375, height: 667, hasTouch: true, isMobile: true, keyboardHeight: 300 },
  { name: 'phone-393', width: 393, height: 852, hasTouch: true, isMobile: true, keyboardHeight: 400 },
  { name: 'phone-412', width: 412, height: 915, hasTouch: true, isMobile: true, keyboardHeight: 420 },
  { name: 'phone-landscape', width: 852, height: 393, hasTouch: true, isMobile: true },
  { name: 'tablet-820', width: 820, height: 1180, hasTouch: true, isMobile: true },
  { name: 'desktop-800', width: 800, height: 600, hasTouch: false, isMobile: false },
  { name: 'desktop-1280', width: 1280, height: 720, hasTouch: false, isMobile: false },
  { name: 'desktop-1920', width: 1920, height: 1080, hasTouch: false, isMobile: false },
  { name: 'touch-1024', width: 1024, height: 768, hasTouch: true, isMobile: false },
];

export const PAIR_VIEWPORTS: readonly [string, string] = ['phone-393', 'desktop-1280'];

const WITHIN_GRID_SETTLE_MS = 60;
const PAST_GRID_SETTLE_MS = 600;

const RESIZE_STORM_STEPS: readonly Step[] = [
  { kind: 'resize-by', deltaHeight: -40 },
  { kind: 'resize-by', deltaHeight: -80 },
  { kind: 'resize-by', deltaWidth: 20 },
  { kind: 'resize-by', deltaWidth: -60, deltaHeight: -40 },
  { kind: 'resize-by', deltaHeight: 40 },
  { kind: 'resize-by', deltaWidth: 0, deltaHeight: 0 },
];

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'phone-wake-prunes-removed',
    phoneOnly: true,
    companionViewport: 'desktop-1280',
    viewports: ['phone-393'],
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'back', viewer: 'a' },
      { kind: 'shot', name: 'before', viewer: 'a' },
      { kind: 'suspend', viewer: 'a' },
      { kind: 'remove-session', viewer: 'b' },
      { kind: 'wait', durationMs: 11000 },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'expect-session-gone', viewer: 'a' },
      { kind: 'shot', name: 'after', viewer: 'a' },
    ],
  },
  {
    name: 'reconnect-catches-up-rename',
    companionViewport: 'desktop-800',
    viewports: ['desktop-1280'],
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b' },
      { kind: 'suspend', viewer: 'a' },
      { kind: 'rename-session', newName: 'renamed while away', viewer: 'b' },
      { kind: 'wait', durationMs: 11000 },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'expect-session-name', name: 'renamed while away', viewer: 'a' },
      { kind: 'shot', name: 'caught-up', viewer: 'a' },
    ],
  },
  {
    name: 'phone-resume-desktop-grid',
    phoneOnly: true,
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'remember', label: 'phone-box', viewer: 'a' },
      { kind: 'suspend', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b' },
      { kind: 'background', viewer: 'b' },
      { kind: 'wait', durationMs: 11000 },
      { kind: 'fit-measurement', available: false, viewer: 'a' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'wait', durationMs: 1000 },
      { kind: 'fit-measurement', available: true, viewer: 'a' },
      { kind: 'assert-fit', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectRemembered: 'phone-box' },
    ],
  },
  {
    name: 'phone-reconnect-scroll',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'type', text: 'history' },
      { kind: 'touch-scroll' },
      { kind: 'offline' },
      { kind: 'online' },
      { kind: 'assert-fit' },
      { kind: 'touch-scroll' },
    ],
  },
  {
    name: 'phone-reconnect-mouse-scroll',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'type', text: 'mouse-history' },
      { kind: 'touch-scroll' },
      { kind: 'offline' },
      { kind: 'online' },
      { kind: 'assert-fit' },
      { kind: 'touch-scroll' },
    ],
  },
  {
    name: 'undo-close',
    viewports: ['phone-393', 'desktop-1280'],
    steps: [{ kind: 'assert-undo-close' }, { kind: 'shot', name: 'undo-close' }],
  },
  {
    name: 'added-session-shown',
    viewports: ['phone-393', 'desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-added-session-shown' }, { kind: 'shot', name: 'added-session-shown' }],
  },
  {
    name: 'boards',
    viewports: ['phone-393', 'desktop-1920'],
    steps: [{ kind: 'assert-boards' }, { kind: 'shot', name: 'boards' }],
  },
  {
    name: 'board-scale',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'assert-board-scale' }, { kind: 'shot', name: 'board-scale' }],
  },
  {
    name: 'terminal-link-repaint',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-link-repaint' }, { kind: 'shot', name: 'link-hovered' }],
  },
  {
    name: 'board-pane',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-board-pane' }, { kind: 'shot', name: 'board-pane' }],
  },
  {
    name: 'rail-drag',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-rail-drag' }, { kind: 'shot', name: 'rail-drag' }],
  },
  {
    name: 'team-review',
    viewports: ['phone-393', 'desktop-1280', 'desktop-800', 'desktop-1920'],
    steps: [{ kind: 'assert-team-review' }, { kind: 'shot', name: 'team-review' }],
  },
  {
    name: 'review-changes',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-review-changes' }, { kind: 'shot', name: 'changes' }],
  },
  {
    name: 'chat-approvals',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-approvals' }, { kind: 'shot', name: 'chat-approvals' }, { kind: 'assert-chat-default' }],
  },
  {
    name: 'chat-done-means',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-done-means' }, { kind: 'shot', name: 'chat-done-means' }],
  },
  {
    name: 'chat-default-phone',
    viewports: ['phone-393'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-chat-default-phone' }],
  },
  {
    name: 'board-session',
    viewports: ['desktop-1280'],
    projectSeed: 'shop',
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-board-session' }, { kind: 'shot', name: 'board-session' }],
  },
  {
    name: 'chat-terminal',
    viewports: ['desktop-1280'],
    skipsPermissions: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-terminal' }, { kind: 'shot', name: 'chat-terminal' }],
  },
  {
    name: 'chat-plan',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-plan' }, { kind: 'shot', name: 'chat-plan' }],
  },
  {
    name: 'chat-elicitation',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-elicitation' }, { kind: 'shot', name: 'chat-elicitation' }],
  },
  {
    name: 'chat-sign-in',
    viewports: ['desktop-1280'],
    skipsPermissions: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-sign-in' }, { kind: 'shot', name: 'chat-sign-in' }],
  },
  {
    name: 'chat-away-reply',
    viewports: ['desktop-1280'],
    skipsPermissions: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-away-reply' }],
  },
  {
    name: 'chat-usage-limit',
    viewports: ['desktop-1280'],
    skipsPermissions: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'type', text: 'stop' }, { kind: 'assert-chat-usage-limit' }, { kind: 'shot', name: 'chat-usage-limit' }],
  },
  {
    name: 'rename-repaints-roster',
    viewports: ['desktop-1280', 'phone-393'],
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'rename-session', newName: 'renamed probe' },
      { kind: 'shot', name: 'renamed' },
    ],
  },
  {
    name: 'cold-open',
    fullMatrix: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'shot', name: 'open' }],
  },
  {
    name: 'reopen-x3',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'back' },
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'back' },
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'shot', name: 'reopened' },
    ],
  },
  {
    name: 'phone-remove-returns-to-focus',
    phoneOnly: true,
    viewports: ['phone-393'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'remove-from-phone-terminal' }],
  },
  {
    name: 'touch-key-strip-contexts',
    phoneOnly: true,
    viewports: ['phone-393'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-key-strip-contexts' }, { kind: 'shot', name: 'key-strip' }],
  },
  {
    name: 'touch-fullscreen-app-row',
    phoneOnly: true,
    viewports: ['phone-393'],
    agent: 'shell',
    steps: [{ kind: 'open' }, { kind: 'assert-fullscreen-app-row' }, { kind: 'shot', name: 'fullscreen-app-row' }],
  },
  {
    name: 'touch-terminal-typing',
    phoneOnly: true,
    viewports: ['phone-393'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-terminal-typing' }, { kind: 'shot', name: 'terminal-typing' }],
  },
  {
    name: 'touch-typing-search',
    phoneOnly: true,
    viewports: ['phone-393'],
    runsOnlyWhenNamed: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'search-terminal-typing' }],
  },
  {
    name: 'touch-select-copy',
    phoneOnly: true,
    viewports: ['phone-393'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-touch-select-copy' }, { kind: 'shot', name: 'select-sheet' }],
  },
  {
    name: 'phone-changes-back',
    viewports: ['phone-393'],
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-phone-changes' }, { kind: 'shot', name: 'changes-list' }],
  },
  {
    name: 'phone-settings-back',
    phoneOnly: true,
    steps: [{ kind: 'assert-settings-back' }],
  },
  {
    name: 'resize-storm',
    fullMatrix: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      ...RESIZE_STORM_STEPS,
      { kind: 'settle' },
      { kind: 'shot', name: 'stormed' },
    ],
  },
  {
    name: 'keyboard',
    phoneOnly: true,
    fullMatrix: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'shot', name: 'keyboard-up' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle' },
    ],
  },
  {
    name: 'two-viewers',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'a', expectGrid: 'following' },
      { kind: 'background', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'shot', name: 'both' },
      { kind: 'back', viewer: 'a' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'shot', name: 'reclaimed' },
    ],
  },
  {
    name: 'offline-online',
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'offline' },
      { kind: 'online' },
      { kind: 'settle' },
      { kind: 'shot', name: 'reattached' },
    ],
  },
  {
    name: 'burst-during-resize',
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'burst', lines: 800 },
      { kind: 'resize-by', deltaHeight: -60 },
      { kind: 'resize-by', deltaHeight: 60 },
      { kind: 'settle' },
      { kind: 'shot', name: 'after-burst' },
    ],
  },
  {
    name: 'hidden-output-deep-history',
    viewports: ['desktop-1280', 'phone-393'],
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'watch-terminal' },
      { kind: 'background' },
      { kind: 'type', text: 'history' },
      { kind: 'type', text: 'history' },
      { kind: 'type', text: 'history' },
      { kind: 'type', text: 'history' },
      { kind: 'type', text: 'frame' },
      { kind: 'expect-terminal-untouched', durationMs: 1500 },
      { kind: 'foreground' },
      { kind: 'expect-revealed' },
      { kind: 'offline' },
      { kind: 'online' },
      { kind: 'load-deep-history' },
      { kind: 'watch-terminal' },
      { kind: 'background' },
      { kind: 'wait', durationMs: 300 },
      { kind: 'foreground' },
      { kind: 'expect-terminal-untouched', durationMs: 1000 },
    ],
  },
  {
    name: 'h1-desktop-first',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
    ],
  },
  {
    name: 'h2-companion-reconnect',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'b' },
      { kind: 'online', viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h2-viewer-reconnect',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'a' },
      { kind: 'online', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h3-reopen-with-companion',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'back', viewer: 'a' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h4-companion-resize',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'resize', width: 1100, height: 700, viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h6-layout-flip',
    viewports: ['touch-1024'],
    steps: [
      { kind: 'open' },
      { kind: 'settle', expectGrid: 'exact' },
      { kind: 'resize', width: 393, height: 852 },
      { kind: 'settle', expectGrid: 'exact' },
    ],
  },
  {
    name: 'h9-desktop-refocus',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
      { kind: 'background', viewer: 'a' },
      { kind: 'foreground', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'a', expectGrid: 'following' },
      { kind: 'background', viewer: 'b' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
    ],
  },
  {
    name: 'h10-blur-during-settle',
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'background', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'foreground', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'resize', width: 1100, height: 700, viewer: 'b' },
      { kind: 'wait', durationMs: WITHIN_GRID_SETTLE_MS, viewer: 'b' },
      { kind: 'background', viewer: 'b' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
    ],
  },
  {
    name: 'keyboard-restores-grid',
    phoneOnly: true,
    fullMatrix: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'tap-terminal' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle', expectRemembered: 'phone-box' },
    ],
  },
  {
    name: 'keyboard-down-after-window-blur',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'tap-terminal' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'window-blur' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle', expectRemembered: 'phone-box' },
    ],
  },
  {
    name: 'keyboard-down-while-unengaged',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'background' },
      { kind: 'keyboard', state: 'down' },
      { kind: 'wait', durationMs: PAST_GRID_SETTLE_MS },
      { kind: 'foreground' },
      { kind: 'settle', expectRemembered: 'phone-box' },
      { kind: 'shot', name: 'keyboard-down-unengaged' },
    ],
  },
  {
    name: 'reconnect-while-backgrounded',
    phoneOnly: true,
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a' },
      { kind: 'remember', label: 'phone-box', viewer: 'a' },
      { kind: 'background', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'a' },
      { kind: 'online', viewer: 'a' },
      { kind: 'foreground', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectRemembered: 'phone-box' },
      { kind: 'shot', name: 'reattached-unengaged' },
    ],
  },
  {
    name: 'keyboard-down-with-focus-in-card',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'remember', label: 'phone-box' },
      { kind: 'tap-terminal' },
      { kind: 'keyboard', state: 'up' },
      { kind: 'settle' },
      { kind: 'background', quiet: true },
      { kind: 'keyboard', state: 'down' },
      { kind: 'settle', expectRemembered: 'phone-box' },
      { kind: 'shot', name: 'keyboard-down-focused' },
    ],
  },
  {
    name: 'hidden-phone-never-steals',
    phoneOnly: true,
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'tap-terminal', viewer: 'a' },
      { kind: 'background', viewer: 'a' },
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'a' },
      { kind: 'online', viewer: 'a' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'expect-link', value: 'connecting', viewer: 'a' },
    ],
  },
  {
    name: 'blurred-viewer-never-steals',
    viewports: ['phone-393'],
    companionViewport: 'desktop-1280',
    steps: [
      { kind: 'open', viewer: 'b' },
      { kind: 'settle', viewer: 'b', expectGrid: 'exact' },
      { kind: 'tap-terminal', viewer: 'b' },
      { kind: 'window-blur', viewer: 'b' },
      { kind: 'open', viewer: 'a' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'offline', viewer: 'b' },
      { kind: 'online', viewer: 'b' },
      { kind: 'settle', viewer: 'a', expectGrid: 'exact' },
      { kind: 'settle', viewer: 'b', expectGrid: 'following' },
    ],
  },
  {
    name: 'resume-after-long-hide',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'suspend' },
      { kind: 'wait', durationMs: 11000 },
      { kind: 'foreground' },
      { kind: 'settle' },
      { kind: 'burst', lines: 5 },
      { kind: 'settle' },
    ],
  },
  {
    name: 'resume-after-short-hide',
    phoneOnly: true,
    steps: [
      { kind: 'open' },
      { kind: 'settle' },
      { kind: 'suspend' },
      { kind: 'wait', durationMs: 1000 },
      { kind: 'foreground' },
      { kind: 'expect-link', value: 'connecting' },
      { kind: 'wait', durationMs: 600 },
      { kind: 'shot', name: 'connecting' },
      { kind: 'burst', lines: 5 },
      { kind: 'settle' },
    ],
  },
  {
    name: 'solid-hello',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'assert-solid-hello' }],
  },
  {
    name: 'solid-island',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'assert-solid-island' }],
  },
  {
    name: 'solid-store-signal',
    viewports: ['desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'assert-solid-store-signal' }],
  },
  {
    name: 'state-core',
    viewports: ['desktop-1280', 'phone-393'],
    steps: [{ kind: 'open' }, { kind: 'assert-state-core' }],
  },
  {
    name: 'ui-primitives-parity',
    viewports: ['desktop-1280', 'phone-393'],
    steps: [{ kind: 'open' }, { kind: 'assert-ui-primitives-parity' }],
  },
  {
    name: 'confirm-dialog',
    viewports: ['phone-393', 'desktop-1280'],
    steps: [{ kind: 'open' }, { kind: 'assert-confirm-dialog' }],
  },
  {
    name: 'self-check-must-fail',
    proveFailure: true,
    steps: [{ kind: 'open' }, { kind: 'settle' }, { kind: 'assert-grid', tickOffset: 1 }],
  },
];

export function layoutFor(viewport: Viewport): Layout {
  return decideLayout({ coarse: viewport.hasTouch, narrowWidth: viewport.width <= PHONE_MAX_WIDTH_PX });
}

function clampToRange(value: number, minimum: number, maximum: number): number {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function resolveStepForViewport(step: Step, viewport: Viewport, layout: Layout): ResolvedStep {
  if (step.kind !== 'resize-by') return step;
  const widthDelta = layout === 'desktop' ? (step.deltaWidth ?? 0) : 0;
  const heightDelta = step.deltaHeight ?? 0;
  return {
    kind: 'resize',
    width: clampToRange(viewport.width + widthDelta, MIN_VIEWPORT_WIDTH_PX, MAX_VIEWPORT_WIDTH_PX),
    height: clampToRange(viewport.height + heightDelta, MIN_VIEWPORT_HEIGHT_PX, MAX_VIEWPORT_HEIGHT_PX),
    viewer: step.viewer,
  };
}

export function heightWithKeyboardUp(currentHeightPx: number, keyboardHeightPx: number): number {
  return clampToRange(currentHeightPx - keyboardHeightPx, MIN_VIEWPORT_HEIGHT_PX, MAX_VIEWPORT_HEIGHT_PX);
}

function viewportNamed(name: string): Viewport | null {
  return VIEWPORTS.find((viewport) => viewport.name === name) ?? null;
}

function otherPairViewportName(name: string): string {
  if (name === PAIR_VIEWPORTS[0]) return PAIR_VIEWPORTS[1];
  return PAIR_VIEWPORTS[0];
}

export function companionFor(viewport: Viewport, scenario: Scenario): Viewport | null {
  const declared = scenario.companionViewport;
  if (declared === undefined) return null;
  if (declared === viewport.name) return viewportNamed(otherPairViewportName(viewport.name));
  return viewportNamed(declared);
}

function needsSoftKeyboard(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.kind === 'keyboard');
}

export function needsSocketRoute(scenario: Pick<Scenario, 'steps'>): boolean {
  return scenario.steps.some((step) => step.kind === 'suspend');
}

export function needsTeamReview(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.kind === 'assert-team-review');
}

export function needsSessionChat(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.kind === 'assert-chat-approvals' || step.kind === 'assert-chat-done-means' || step.kind === 'assert-chat-terminal' || step.kind === 'assert-chat-plan' || step.kind === 'assert-chat-elicitation' || step.kind === 'assert-chat-sign-in' || step.kind === 'assert-chat-usage-limit' || step.kind === 'assert-chat-away-reply' || step.kind === 'assert-chat-default' || step.kind === 'assert-chat-default-phone' || step.kind === 'assert-board-session');
}

export function needsGitOrigin(scenario: Scenario): boolean {
  if (scenario.projectSeed !== undefined) return true;
  return scenario.steps.some((step) => step.kind === 'assert-review-changes' || step.kind === 'assert-chat-done-means' || step.kind === 'assert-board-pane' || step.kind === 'assert-phone-changes');
}

function scenarioRunsOnViewport(scenario: Scenario, viewport: Viewport, layout: Layout, proveFailure: boolean): boolean {
  if (scenario.proveFailure === true && !proveFailure) return false;
  if (scenario.phoneOnly === true && layout !== 'phone') return false;
  if (needsSoftKeyboard(scenario) && viewport.keyboardHeight === undefined) return false;
  if (scenario.viewports) return scenario.viewports.includes(viewport.name);
  if (scenario.fullMatrix === true) return true;
  return PAIR_VIEWPORTS.includes(viewport.name);
}

export function casesFor(options: CasesForOptions = {}): HarnessCase[] {
  const wantedViewportNames = options.viewportNames;
  const wantedScenarioNames = options.only;
  const selectedViewports = wantedViewportNames
    ? VIEWPORTS.filter((viewport) => wantedViewportNames.includes(viewport.name))
    : VIEWPORTS;
  const selectedScenarios = wantedScenarioNames
    ? SCENARIOS.filter((scenario) => wantedScenarioNames.includes(scenario.name))
    : SCENARIOS.filter((scenario) => scenario.runsOnlyWhenNamed !== true);
  const proveFailure = options.proveFailure === true;
  const resolved: HarnessCase[] = [];
  for (const viewport of selectedViewports) {
    const expectedLayout = layoutFor(viewport);
    for (const scenario of selectedScenarios) {
      if (!scenarioRunsOnViewport(scenario, viewport, expectedLayout, proveFailure)) continue;
      resolved.push({
        viewport,
        scenario: {
          ...scenario,
          steps: scenario.steps.map((step) => resolveStepForViewport(step, viewport, expectedLayout)),
        },
        expectedLayout,
        companion: companionFor(viewport, scenario),
      });
    }
  }
  return resolved;
}

export const DONE_CHILD_NAME = 'done-child';
export const DONE_CHILD_LINES = ['The status check passes', 'done-means.txt is committed'];
export const AWAY_REPLY_TEXT = 'Written while you were away.';
export const RESUMED_AFTER_QUESTION_TEXT = 'Going with the rollout you picked.';
export const BOARD_ASK_QUESTION = 'Should refunds go through the card module too, or keep their own charge path so the two can change apart later?';
export const STACKED_ANSWERS_PREFIX = 'Answers received: ';
export const PLAN_REPLY_PREFIX = 'Plan decision: ';
export const ELICITATION_REPLY_PREFIX = 'Form reply: ';
export const ELICITATION_SERVER_NAME = 'linear';
export const ELICITATION_LINK_URL = 'https://example.com/oauth/start';
export const PROPOSED_PLAN_HEADING = 'Worker per board';
export const DIRECTOR_DIGEST_TEXT = 'Checkout totals now add tax before the card charge';
export const DIRECTOR_MISFIT_TEXT = 'It committed a refund policy file the task never asked for.';
export const STUDIO_PROGRESS_ANSWER = 'Checkout totals are in, and no plan step is left.';
export const LONG_CHECKOUT_REPLY = `I changed src/checkout/checkout.js so the order total adds tax before the charge reaches the card module. ${'The tax table is read once per order, rounded to cents, and logged beside the order id for support. '.repeat(5)}`;
export const AGENT_DONE_LINE = { text: 'node starts in the worktree', command: 'node --version' };

export function needsDoneMeansChecks(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.kind === 'assert-chat-done-means');
}

export const SHOWN_PAGE_FILE_NAME = 'chapter-ticks.html';
export const SHOWN_PAGE_TICKED_TEXT = 'Ticked';
export const SHOWN_PAGE_REPLY = 'The chapter ticks page is on the map.';
export const SHOW_CARD_BELOW_COMMAND = 'show-card-below ';
export const SHOWN_CARD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect width="240" height="60" fill="#2f855a"/></svg>';
export const SHOWN_PAGE_HTML = `<!doctype html><html><head><title>Chapter ticks</title></head><body><button type="button" id="tick">Tick</button><script>
document.getElementById('tick').addEventListener('click', (event) => { event.currentTarget.textContent = '${SHOWN_PAGE_TICKED_TEXT}'; });
</script></body></html>`;

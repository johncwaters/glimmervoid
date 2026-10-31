import type { SessionState } from './states.ts';
import { STATES } from './states.ts';

export type StatusIcon = 'not-started' | 'starting' | 'working' | 'monitoring' | 'needs-input' | 'idle' | 'complete' | 'exited' | 'failed' | 'shell';

interface StatusIconShape {
  tag: 'circle' | 'path' | 'rect';
  attributes: Readonly<Record<string, string>>;
}

export const STATE_ICONS: Readonly<Record<SessionState, StatusIcon>> = Object.freeze({
  [STATES.DORMANT]:      'not-started',
  [STATES.INITIALIZING]: 'starting',
  [STATES.STARTING]:     'starting',
  [STATES.RUNNING]:      'working',
  [STATES.WAITING]:      'needs-input',
  [STATES.IDLE]:         'idle',
  [STATES.COMPLETE]:     'complete',
  [STATES.DONE]:         'exited',
  [STATES.FAILED]:       'failed',
});

export const MONITORING_ICON: StatusIcon = 'monitoring';

const stroke = (width: string) => ({ fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const edge = (width: string) => ({ fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' });
const fill = { fill: 'currentColor' };

const BRACKETS = 'M5.8 4.2L8 2L10.2 4.2M11.8 5.8L14 8L11.8 10.2M10.2 11.8L8 14L5.8 11.8M4.2 10.2L2 8L4.2 5.8';
const BLURRED_BRACKETS = 'M5.07 3.62C5.63 3.21 7.3 2 8 2C8.7 2 10.37 3.21 10.93 3.62M12.38 5.07C12.79 5.63 14 7.3 14 8C14 8.7 12.79 10.37 12.38 10.93M10.93 12.38C10.37 12.79 8.7 14 8 14C7.3 14 5.63 12.79 5.07 12.38M3.62 10.93C3.21 10.37 2 8.7 2 8C2 7.3 3.21 5.63 3.62 5.07';
const SMALL_DIAMOND = 'M8 3.4L12.6 8L8 12.6L3.4 8Z';

export const STATUS_ICON_SHAPES: Readonly<Record<StatusIcon, readonly StatusIconShape[]>> = Object.freeze({
  'not-started': [
    { tag: 'path', attributes: { d: BRACKETS, ...edge('1.8'), 'stroke-opacity': '.75' } },
  ],
  starting: [
    { tag: 'path', attributes: { d: BRACKETS, ...edge('1.8'), class: 'status-icon-spin' } },
    { tag: 'path', attributes: { d: BLURRED_BRACKETS, ...edge('1.8'), class: 'status-icon-spin-blur' } },
  ],
  working: [
    { tag: 'path', attributes: { d: SMALL_DIAMOND, ...edge('1.3'), class: 'status-icon-ping' } },
    { tag: 'path', attributes: { d: SMALL_DIAMOND, ...fill, class: 'status-icon-beat' } },
  ],
  monitoring: [
    { tag: 'path', attributes: { d: 'M1.2 8L8 3.4L14.8 8L8 12.6Z', ...edge('1.6') } },
    { tag: 'path', attributes: { d: 'M8 6.1L9.9 8L8 9.9L6.1 8Z', ...fill, class: 'status-icon-look' } },
  ],
  'needs-input': [
    { tag: 'path', attributes: { d: 'M4.6 5.2a3.4 3.4 0 1 1 4.9 3.05c-1 .5-1.5 1.1-1.5 2.05v.6', ...stroke('2.5') } },
    { tag: 'circle', attributes: { cx: '8', cy: '14', r: '1.55', ...fill } },
  ],
  idle: [
    { tag: 'rect', attributes: { x: '3.6', y: '2.8', width: '3', height: '10.4', rx: '.8', ...fill } },
    { tag: 'rect', attributes: { x: '9.4', y: '2.8', width: '3', height: '10.4', rx: '.8', ...fill } },
  ],
  complete: [
    { tag: 'path', attributes: { d: 'M2.8 8.4l3.4 3.4 7-7.4', ...stroke('2.2') } },
  ],
  exited: [
    { tag: 'path', attributes: { d: 'M8 2L14 8L8 14L2 8Z', ...edge('1.8'), 'stroke-opacity': '.6' } },
  ],
  failed: [
    { tag: 'path', attributes: { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9', ...stroke('2') } },
  ],
  shell: [
    { tag: 'path', attributes: { d: 'M3 4.5L6.5 8L3 11.5 M8.5 11.5h4.5', ...stroke('1.8') } },
  ],
});

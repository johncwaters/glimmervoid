import type { SessionState } from './states.ts';
import { STATES } from './states.ts';

export type StatusIcon = 'not-started' | 'starting' | 'working' | 'monitoring' | 'needs-input' | 'idle' | 'exited' | 'failed';

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
  [STATES.COMPLETE]:     'idle',
  [STATES.DONE]:         'exited',
  [STATES.FAILED]:       'failed',
});

export const MONITORING_ICON: StatusIcon = 'monitoring';

const stroke = (width: string) => ({ fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const fill = { fill: 'currentColor' };

export const STATUS_ICON_SHAPES: Readonly<Record<StatusIcon, readonly StatusIconShape[]>> = Object.freeze({
  'not-started': [
    { tag: 'circle', attributes: { cx: '8', cy: '8', r: '6', ...stroke('1.6'), 'stroke-linecap': 'butt', 'stroke-dasharray': '2.6 2.1' } },
  ],
  starting: [
    { tag: 'circle', attributes: { cx: '8', cy: '8', r: '6', ...stroke('1.8'), 'stroke-opacity': '.25' } },
    { tag: 'path', attributes: { d: 'M8 2a6 6 0 0 1 6 6', ...stroke('1.8'), class: 'status-icon-spin' } },
  ],
  working: [
    { tag: 'circle', attributes: { cx: '8', cy: '8', r: '4', ...stroke('1.4'), class: 'status-icon-ping' } },
    { tag: 'circle', attributes: { cx: '8', cy: '8', r: '4', ...fill } },
  ],
  monitoring: [
    { tag: 'path', attributes: { d: 'M1.3 8S3.8 3.4 8 3.4 14.7 8 14.7 8 12.2 12.6 8 12.6 1.3 8 1.3 8z', ...stroke('1.5') } },
    { tag: 'circle', attributes: { cx: '8', cy: '8', r: '2.2', ...fill } },
  ],
  'needs-input': [
    { tag: 'path', attributes: { d: 'M4.6 5.2a3.4 3.4 0 1 1 4.9 3.05c-1 .5-1.5 1.1-1.5 2.05v.6', ...stroke('2.5') } },
    { tag: 'circle', attributes: { cx: '8', cy: '14', r: '1.55', ...fill } },
  ],
  idle: [
    { tag: 'rect', attributes: { x: '3.6', y: '2.8', width: '3', height: '10.4', rx: '.8', ...fill } },
    { tag: 'rect', attributes: { x: '9.4', y: '2.8', width: '3', height: '10.4', rx: '.8', ...fill } },
  ],
  exited: [
    { tag: 'rect', attributes: { x: '3', y: '3', width: '10', height: '10', rx: '1.6', ...fill } },
  ],
  failed: [
    { tag: 'path', attributes: { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9', ...stroke('2') } },
  ],
});

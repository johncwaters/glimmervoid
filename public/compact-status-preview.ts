import { STATES } from '#shared/states.ts';
import { el } from './dom-helpers.ts';
import { buildPillSkeleton, paintPillStatus } from './focus-view/pill-dom.ts';

const EXAMPLE_SESSIONS = [
  { name: 'glimmervoid', state: STATES.RUNNING, awaitingBackgroundTasks: false },
  { name: 'glimmervoid (2)', state: STATES.RUNNING, awaitingBackgroundTasks: true },
  { name: 'api', state: STATES.WAITING, awaitingBackgroundTasks: false },
  { name: 'docs-site', state: STATES.IDLE, awaitingBackgroundTasks: false },
];

export function renderCompactStatusPreview() {
  const preview = el('div', 'compact-status-preview');
  preview.setAttribute('role', 'img');
  preview.setAttribute('aria-label', 'Example sidebar sessions showing how status appears with this setting');
  for (const session of EXAMPLE_SESSIONS) {
    const { pill, refs } = buildPillSkeleton('div', 'focus-pill compact-status-preview-pill');
    refs.name.textContent = session.name;
    paintPillStatus(pill, refs, session.state, session.awaitingBackgroundTasks);
    preview.append(pill);
  }
  return preview;
}

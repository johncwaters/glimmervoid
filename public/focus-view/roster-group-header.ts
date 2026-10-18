import { el } from '../dom-helpers.ts';
import type { RosterGroup } from './roster-groups-core.ts';
import { NO_PATH_KEY } from './roster-groups-core.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';

export interface SessionGroupHeader {
  header: HTMLDivElement;
  label: HTMLSpanElement;
  count: HTMLSpanElement;
  addButton: HTMLButtonElement;
  forgetButton: HTMLButtonElement;
}

export function buildSessionGroupHeader({ onAdd, onForget }: {
  onAdd: (path: string | undefined, label: string | undefined) => void;
  onForget: (path: string | undefined) => void;
}): SessionGroupHeader {
  const header = el('div', 'session-group-header');
  const label = el('span', 'session-group-label');
  const count = el('span', 'session-group-count');
  const rule = el('span', 'session-group-rule');
  rule.setAttribute('aria-hidden', 'true');
  const addButton = el('button', 'session-group-add', '+');
  addButton.type = 'button';
  addButton.addEventListener('click', () => onAdd(header.dataset.path, header.dataset.label));
  const forgetButton = el('button', 'session-group-forget');
  forgetButton.type = 'button';
  forgetButton.append(createLineIcon(CLOSE_ICON_PATH));
  forgetButton.addEventListener('click', () => onForget(header.dataset.path));
  header.append(label, count, rule, forgetButton, addButton);
  return { header, label, count, addButton, forgetButton };
}

export function paintSessionGroupHeader(refs: SessionGroupHeader, group: RosterGroup<unknown>, surfaceName: string) {
  const { header, label, count, addButton, forgetButton } = refs;
  const isPathless = group.key === NO_PATH_KEY;
  const isEmpty = group.rows.length === 0;
  header.dataset.path = group.key;
  header.dataset.label = group.label;
  header.title = group.title;
  header.toggleAttribute('data-empty', isEmpty);
  label.textContent = group.label;
  count.textContent = String(group.rows.length);
  count.title = `${group.rows.length} ${group.rows.length === 1 ? 'session' : 'sessions'}`;
  addButton.hidden = isPathless;
  forgetButton.hidden = isPathless || !isEmpty;
  if (!isPathless) {
    addButton.title = `Add a session to ${group.label}`;
    addButton.setAttribute('aria-label', `Add a session to ${group.label}`);
  }
  if (!isPathless && isEmpty) {
    forgetButton.title = `Remove ${group.label} from the ${surfaceName}`;
    forgetButton.setAttribute('aria-label', `Remove ${group.label} from the ${surfaceName}`);
  }
}

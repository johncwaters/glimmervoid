import { writeAttributeIfChanged, writeDataIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { RosterGroup } from './roster-groups-core.ts';
import { NO_PATH_KEY } from './roster-groups-core.ts';
import { CLOSE_ICON_PATH, PLUS_ICON_PATH, createLineIcon } from '../svg-dom.ts';

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
  const addButton = button({ variant: 'icon', size: 'small', label: 'Add session to this project', icon: createLineIcon(PLUS_ICON_PATH), action: 'add-group-session', onClick: () => onAdd(header.dataset.path, header.dataset.label) });
  const forgetButton = button({ variant: 'icon', size: 'small', label: 'Remove this project from the list', icon: createLineIcon(CLOSE_ICON_PATH), action: 'forget-group', onClick: () => onForget(header.dataset.path) });
  header.append(label, count, rule, forgetButton, addButton);
  return { header, label, count, addButton, forgetButton };
}

export function paintSessionGroupHeader(refs: SessionGroupHeader, group: RosterGroup<unknown>) {
  const { header, label, count, addButton, forgetButton } = refs;
  const isPathless = group.key === NO_PATH_KEY;
  const isEmpty = group.rows.length === 0;
  writeDataIfChanged(header, 'path', group.key);
  writeDataIfChanged(header, 'label', group.label);
  writeAttributeIfChanged(header, 'title', group.title);
  header.toggleAttribute('data-empty', isEmpty);
  writeTextIfChanged(label, group.label);
  writeTextIfChanged(count, String(group.rows.length));
  writeAttributeIfChanged(count, 'title', `${group.rows.length} ${group.rows.length === 1 ? 'session' : 'sessions'}`);
  writeHiddenIfChanged(addButton, isPathless);
  writeHiddenIfChanged(forgetButton, isPathless || !isEmpty);
}

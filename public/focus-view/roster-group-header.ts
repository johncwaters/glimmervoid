import { writeDataIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { RosterGroup } from './roster-groups-core.ts';
import { PLUS_ICON_PATH, createLineIcon } from '../svg-dom.ts';

export interface SessionGroupHeader {
  header: HTMLDivElement;
  label: HTMLSpanElement;
  count: HTMLSpanElement;
  addButton: HTMLButtonElement;
}

export function buildSessionGroupHeader({ onAdd }: {
  onAdd: (path: string | undefined, label: string | undefined) => void;
}): SessionGroupHeader {
  const header = el('div', 'session-group-header');
  const label = el('span', 'session-group-label');
  const count = el('span', 'session-group-count');
  const rule = el('span', 'session-group-rule');
  rule.setAttribute('aria-hidden', 'true');
  const addButton = button({ variant: 'icon', size: 'small', label: 'Add session to this project', icon: createLineIcon(PLUS_ICON_PATH), action: 'add-group-session', onClick: () => onAdd(header.dataset.path, header.dataset.label) });
  header.append(label, count, rule, addButton);
  return { header, label, count, addButton };
}

export function paintSessionGroupHeader(refs: SessionGroupHeader, group: RosterGroup<unknown>) {
  const { header, label, count, addButton } = refs;
  writeDataIfChanged(header, 'path', group.projectPath ?? '');
  writeDataIfChanged(header, 'label', group.label);
  writeTextIfChanged(label, group.label);
  writeTextIfChanged(count, String(group.rows.length));
  writeHiddenIfChanged(count, group.rows.length === 0);
  writeHiddenIfChanged(addButton, group.projectPath === null);
}

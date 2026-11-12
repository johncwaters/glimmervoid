import { writeAttributeIfChanged, writeDataIfChanged, writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { RosterGroup } from './roster-groups-core.ts';
import { PLUS_ICON_PATH, createLineIcon } from '../svg-dom.ts';

export interface SessionGroupHeader {
  header: HTMLDivElement;
  foldButton: HTMLButtonElement;
  label: HTMLSpanElement;
  count: HTMLSpanElement;
  addButton: HTMLButtonElement;
}

const FOLD_CHEVRON_PATH = 'M4 6l4 4l4-4';

export function buildSessionGroupHeader({ onAdd, onToggleFold }: {
  onAdd: (path: string | undefined, label: string | undefined) => void;
  onToggleFold?: (groupKey: string) => void;
}): SessionGroupHeader {
  const header = el('div', 'session-group-header');
  const foldButton = button({ variant: 'icon', size: 'small', label: 'Project sessions', icon: createLineIcon(FOLD_CHEVRON_PATH), action: 'fold-group' });
  foldButton.classList.add('session-group-fold');
  const label = el('span', 'session-group-label');
  const count = el('span', 'session-group-count');
  const rule = el('span', 'session-group-rule');
  rule.setAttribute('aria-hidden', 'true');
  const addButton = button({ variant: 'icon', size: 'small', label: 'Add session to this project', icon: createLineIcon(PLUS_ICON_PATH), action: 'add-group-session', onClick: () => onAdd(header.dataset.path, header.dataset.label) });
  foldButton.hidden = !onToggleFold;
  header.addEventListener('click', (event) => {
    if (!onToggleFold || !header.dataset.key) return;
    if (event.target instanceof Element && addButton.contains(event.target)) return;
    onToggleFold(header.dataset.key);
  });
  header.append(foldButton, label, count, rule, addButton);
  return { header, foldButton, label, count, addButton };
}

export function paintSessionGroupHeader(refs: SessionGroupHeader, group: RosterGroup<unknown>, { isFolded = false, hasWaitingSession = false }: { isFolded?: boolean; hasWaitingSession?: boolean } = {}) {
  const { header, foldButton, label, count, addButton } = refs;
  writeDataIfChanged(header, 'key', group.key);
  writeDataIfChanged(header, 'path', group.projectPath ?? '');
  writeDataIfChanged(header, 'label', group.label);
  writeDataIfChanged(header, 'folded', String(isFolded));
  writeDataIfChanged(header, 'waiting', String(isFolded && hasWaitingSession));
  writeAttributeIfChanged(foldButton, 'aria-expanded', String(!isFolded));
  writeTextIfChanged(label, group.label);
  writeTextIfChanged(count, String(group.rows.length));
  writeHiddenIfChanged(count, group.rows.length === 0);
  writeHiddenIfChanged(addButton, group.projectPath === null);
}

import type { IconName } from '#shared/contracts/whiteboard.ts';
import { ICON_CATALOG, ICON_CATEGORIES, ICON_NAMES } from '#shared/whiteboard-icons.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { createLineIcon, createSvgIcon, PLUS_ICON_PATH } from '../svg-dom.ts';
import { button } from '../ui/button.ts';

const GLYPH_SIZE_PX = 16;

interface IconPickerOptions {
  field: string;
  icon: IconName | null;
  isRequired: boolean;
  accessibleName: string;
  commit: (icon: IconName | null) => void;
}

export function iconGlyph(name: IconName): SVGSVGElement {
  const glyph = createSvgIcon(24, 24);
  glyph.setAttribute('width', String(GLYPH_SIZE_PX));
  glyph.setAttribute('height', String(GLYPH_SIZE_PX));
  glyph.setAttribute('fill', 'none');
  glyph.setAttribute('stroke', 'currentColor');
  glyph.setAttribute('stroke-width', '2');
  glyph.setAttribute('stroke-linecap', 'round');
  glyph.setAttribute('stroke-linejoin', 'round');
  glyph.innerHTML = ICON_CATALOG[name].elements.join('');
  return glyph;
}

function matchesQuery(name: IconName, query: string): boolean {
  return name.includes(query) || ICON_CATALOG[name].label.toLowerCase().includes(query);
}

export function iconPicker({ field, icon, isRequired, accessibleName, commit }: IconPickerOptions): HTMLElement {
  const picker = el('div', 'wb-icon-picker');
  picker.dataset.field = field;
  const popover = el('div', 'wb-icon-popover');
  popover.hidden = true;
  popover.tabIndex = -1;
  const search = markAsNotCredential(el('input', 'wb-inspect-input wb-icon-search'));
  search.type = 'search';
  search.placeholder = 'search icons';
  search.setAttribute('aria-label', `Search icons for ${accessibleName}`);
  const choiceByName = new Map<IconName, HTMLButtonElement>();
  const close = () => {
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  const pick = (name: IconName | null) => {
    close();
    trigger.focus();
    if (name !== icon) commit(name);
  };
  const trigger = button({
    variant: 'icon', size: 'small', label: accessibleName, icon: icon ? iconGlyph(icon) : createLineIcon(PLUS_ICON_PATH, '1.5'), action: 'icon-pick',
    onClick: () => {
      const isOpening = popover.hidden;
      popover.hidden = !isOpening;
      trigger.setAttribute('aria-expanded', String(isOpening));
      if (isOpening) search.focus();
    },
  });
  trigger.classList.add('wb-icon-trigger');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'true');
  const groups = ICON_CATEGORIES.map((category) => {
    const group = el('div', 'wb-icon-group');
    const grid = el('div', 'wb-icon-grid');
    for (const name of ICON_NAMES.filter((candidate) => ICON_CATALOG[candidate].category === category)) {
      const choice = button({ variant: 'icon', size: 'small', label: ICON_CATALOG[name].label, icon: iconGlyph(name), action: 'icon-choice', onClick: () => pick(name) });
      choice.dataset.icon = name;
      choice.classList.add('wb-icon-choice');
      choice.setAttribute('aria-pressed', String(name === icon));
      choiceByName.set(name, choice);
      grid.append(choice);
    }
    group.append(el('span', 'wb-icon-group-label', category), grid);
    return { group, grid };
  });
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    for (const [name, choice] of choiceByName) choice.hidden = !matchesQuery(name, query);
    for (const { group, grid } of groups) group.hidden = [...grid.children].every((choice) => choice instanceof HTMLElement && choice.hidden);
  };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const firstVisible = [...choiceByName].find(([, choice]) => !choice.hidden);
    if (firstVisible) pick(firstVisible[0]);
  });
  popover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
    trigger.focus();
  });
  const clear = button({ variant: 'quiet', size: 'small', label: 'no icon', action: 'icon-clear', onClick: () => pick(null), disabled: isRequired || icon === null });
  popover.append(search, ...groups.map(({ group }) => group), clear);
  picker.append(trigger, popover);
  return picker;
}

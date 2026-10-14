import { el, query, stateChip } from '../dom-helpers.ts';

type PillRefs = ReturnType<typeof buildPillSkeleton>['refs'];
type PrChipsPainter = (slot: HTMLElement, sessionId: string) => void;
let paintPillPrChips: PrChipsPainter | null = null;

export function setPillPrChipsPainter(painter: PrChipsPainter) {
  paintPillPrChips = painter;
}

export function buildPillSkeleton<Tag extends 'button' | 'div'>(tagName: Tag, className: string) {
  const pill = el(tagName, className);
  pill.innerHTML = '<span class="focus-pill-name"></span>'
    + '<span class="focus-pill-badge">'
    + '<span class="focus-pill-glyph"></span><span class="focus-pill-label"></span></span>'
    + '<span class="focus-pill-merge"></span>'
    + '<span class="session-pr-chips focus-pill-prs" hidden></span>';
  const refs = {
    glyph: query(pill, '.focus-pill-glyph'),
    label: query(pill, '.focus-pill-label'),
    name: query(pill, '.focus-pill-name'),
    merge: query(pill, '.focus-pill-merge'),
    prs: query(pill, '.focus-pill-prs'),
  };
  return { pill, refs };
}

export function paintPillStatus(pill: HTMLElement, refs: Pick<PillRefs, 'glyph' | 'label'> & Partial<Pick<PillRefs, 'prs'>>, state: string, awaitingBackgroundTasks = false) {
  pill.dataset.state = state;
  const { glyph, label, isMonitoring } = stateChip(state, awaitingBackgroundTasks);
  pill.toggleAttribute('data-monitoring', isMonitoring);
  refs.glyph.textContent = glyph;
  refs.label.textContent = label;
  if (refs.prs && pill.dataset.id) paintPillPrChips?.(refs.prs, pill.dataset.id);
  return label;
}

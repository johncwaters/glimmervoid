import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { CHAT_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { outlineIconButton } from '../ui/button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { diplomacyEntriesOf, diplomacyItemsOf } from './diplomacy-log-core.ts';
import type { DiplomacyEntry, DiplomacyEntryKind, DiplomacyItem, SeatNote } from './diplomacy-log-core.ts';
import { SEAT_COLORS, seatLabelOf, THOUGHT_CLOUD_PATH } from './wargames-map.ts';
import type { WargamesPov } from './wargames-store.ts';

const ENTRY_GLYPHS: Readonly<Record<DiplomacyEntryKind, { path: string; color: string }>> = Object.freeze({
  message: { path: CHAT_ICON_PATH, color: 'var(--text-dim)' },
  note: { path: THOUGHT_CLOUD_PATH, color: 'var(--text-muted)' },
});

function speakerTextOf(state: MatchState, entry: DiplomacyEntry): string {
  const speaker = seatLabelOf(state, entry.from);
  if (entry.to !== null) return `${speaker} to ${seatLabelOf(state, entry.to)}`;
  if (entry.channel === 'public') return `${speaker} to everyone`;
  return speaker;
}

function buildRow(state: MatchState, entry: DiplomacyEntry, isThreadReply = false): HTMLElement {
  const row = el('li', 'wg-dip-row');
  row.dataset.kind = entry.kind;
  row.dataset.current = String(entry.tick === state.tick);
  const swatch = el('span', 'wg-dip-swatch');
  swatch.style.background = SEAT_COLORS[entry.from];
  const glyph = createLineIcon(ENTRY_GLYPHS[entry.kind].path, '1.5');
  glyph.classList.add('wg-dip-glyph');
  glyph.style.color = ENTRY_GLYPHS[entry.kind].color;
  row.append(
    el('span', 'wg-dip-turn', isThreadReply ? '' : `T${entry.tick}`),
    swatch,
    el('span', 'wg-dip-who', speakerTextOf(state, entry)),
    glyph,
    el('span', 'wg-dip-text', entry.text),
  );
  return row;
}

function buildItem(state: MatchState, item: DiplomacyItem): HTMLElement {
  if (item.kind === 'entry') return buildRow(state, item.entry);
  const thread = el('li', 'wg-dip-thread');
  const threadList = el('ol', 'wg-dip-list');
  threadList.append(...item.entries.map((entry, entryIndex) => buildRow(state, entry, entryIndex > 0)));
  thread.append(threadList);
  return thread;
}

export function createDiplomacyLog(readNotes: () => SeatNote[]): { element: HTMLElement; update(state: MatchState, pov: WargamesPov): void } {
  const element = el('section', 'wg-dip');
  let areNotesShown = false;
  let latest: { state: MatchState; pov: WargamesPov } | null = null;
  const notesToggle = outlineIconButton({
    label: 'Notes',
    icon: createLineIcon(THOUGHT_CLOUD_PATH, '1.5'),
    size: 'small',
    states: ['idle', 'pressed'],
    onClick: () => {
      areNotesShown = !areNotesShown;
      notesToggle.setState(areNotesShown ? 'pressed' : 'idle');
      if (latest) draw(latest.state, latest.pov);
    },
  });
  const heading = sectionHeading({ title: 'Diplomacy', level: 3, actions: [notesToggle.element] });
  const list = el('ol', 'wg-dip-list');
  const empty = el('p', 'wg-empty-copy', 'No messages yet.');
  element.append(heading.element, list, empty);

  function draw(state: MatchState, pov: WargamesPov): void {
    latest = { state, pov };
    const isGodView = pov === 'god';
    notesToggle.element.hidden = !isGodView;
    const notes = isGodView && areNotesShown ? readNotes() : [];
    const entries = diplomacyEntriesOf(state, pov, notes);
    list.replaceChildren(...diplomacyItemsOf(entries).map((item) => buildItem(state, item)));
    empty.hidden = entries.length > 0;
  }

  return { element, update: draw };
}

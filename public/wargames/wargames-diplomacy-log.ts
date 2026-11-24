import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { CHAT_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { outlineIconButton } from '../ui/button.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { diplomacyEntriesOf } from './diplomacy-log-core.ts';
import type { DiplomacyEntry, DiplomacyEntryKind, SeatNote } from './diplomacy-log-core.ts';
import { BREACH_WARNING_PATH, PACT_SCROLL_PATH, SEAT_COLORS, seatLabelOf, THOUGHT_CLOUD_PATH } from './wargames-map.ts';
import type { WargamesPov } from './wargames-store.ts';

const CONTRACT_NAMES: Readonly<Record<NonNullable<DiplomacyEntry['contractKind']>, string>> = Object.freeze({
  escrow: 'Escrow',
  nap: 'Pact',
  alliance: 'Alliance',
});

const CONTRACT_VERBS: Readonly<Record<Exclude<DiplomacyEntryKind, 'message' | 'note'>, string>> = Object.freeze({
  proposed: 'proposed',
  accepted: 'accepted',
  breached: 'broken',
  expired: 'expired',
});

const ENTRY_GLYPHS: Readonly<Record<DiplomacyEntryKind, { path: string; color: string }>> = Object.freeze({
  message: { path: CHAT_ICON_PATH, color: 'var(--text-dim)' },
  note: { path: THOUGHT_CLOUD_PATH, color: 'var(--text-muted)' },
  proposed: { path: PACT_SCROLL_PATH, color: 'var(--text-dim)' },
  accepted: { path: PACT_SCROLL_PATH, color: 'var(--state-running)' },
  breached: { path: BREACH_WARNING_PATH, color: 'var(--state-failed)' },
  expired: { path: PACT_SCROLL_PATH, color: 'var(--text-muted)' },
});

function speakerTextOf(state: MatchState, entry: DiplomacyEntry): string {
  const speaker = seatLabelOf(state, entry.from);
  if (entry.to !== null) return `${speaker} to ${seatLabelOf(state, entry.to)}`;
  if (entry.channel === 'public') return `${speaker} to everyone`;
  if (entry.channel === 'tribe') return `${speaker} to tribe`;
  return speaker;
}

function entryTextOf(entry: DiplomacyEntry): string {
  if (entry.kind === 'message' || entry.kind === 'note') return entry.text;
  const contractName = entry.contractKind ? CONTRACT_NAMES[entry.contractKind] : 'Contract';
  return `${contractName} ${CONTRACT_VERBS[entry.kind]}`;
}

function buildRow(state: MatchState, entry: DiplomacyEntry): HTMLElement {
  const row = el('li', 'wg-dip-row');
  row.dataset.kind = entry.kind;
  row.dataset.current = String(entry.tick === state.tick);
  const swatch = el('span', 'wg-dip-swatch');
  swatch.style.background = SEAT_COLORS[entry.from];
  const glyph = createLineIcon(ENTRY_GLYPHS[entry.kind].path, '1.5');
  glyph.classList.add('wg-dip-glyph');
  glyph.style.color = ENTRY_GLYPHS[entry.kind].color;
  row.append(
    el('span', 'wg-dip-turn', `T${entry.tick}`),
    swatch,
    el('span', 'wg-dip-who', speakerTextOf(state, entry)),
    glyph,
    el('span', 'wg-dip-text', entryTextOf(entry)),
  );
  return row;
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
  const empty = el('p', 'wg-empty-copy', 'No messages or contracts yet.');
  element.append(heading.element, list, empty);

  function draw(state: MatchState, pov: WargamesPov): void {
    latest = { state, pov };
    const isGodView = pov === 'god';
    notesToggle.element.hidden = !isGodView;
    const notes = isGodView && areNotesShown ? readNotes() : [];
    const entries = diplomacyEntriesOf(state, pov, notes);
    list.replaceChildren(...entries.map((entry) => buildRow(state, entry)));
    empty.hidden = entries.length > 0;
  }

  return { element, update: draw };
}

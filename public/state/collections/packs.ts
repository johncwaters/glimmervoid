import type { PacksStatus } from '#shared/contracts/control/pack-messages.ts';
import { reportTerminalColors } from '../../terminal-color-report.ts';
import { setPackThemes } from '../../theme.ts';
import { defineCollection, watchCollection } from '../define-collection.ts';
import {
  INITIAL_PACKS_STATE,
  PACKS_TAB_HASH,
  applyPacksServerMessage,
} from '../packs-core.ts';
import type { PacksCollectionState } from '../packs-core.ts';

const packsCollection = defineCollection<PacksCollectionState>({
  name: 'packs',
  key: null,
  initial: INITIAL_PACKS_STATE,
  apply: applyPacksServerMessage,
  onApplied(message) {
    if (message.type !== 'packs-status') return;
    if (setPackThemes(message.themes)) reportTerminalColors();
  },
});

export function packsSnapshot(): PacksStatus | null {
  return packsCollection.state.status;
}

export function watchPacksCollection(listener: () => void): () => void {
  return watchCollection(
    packsCollection,
    (state) => `${state.serverRevision}:${state.optimisticRevision}`,
    () => listener(),
  );
}

export { PACKS_TAB_HASH };
export default packsCollection;

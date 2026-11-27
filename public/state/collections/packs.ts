import { createEffect, createRoot, flush, runWithOwner } from 'solid-js';
import type { PacksStatus } from '#shared/contracts/control/pack-messages.ts';
import { reportTerminalColors } from '../../terminal-color-report.ts';
import { setPackThemes } from '../../theme.ts';
import { defineCollection } from '../define-collection.ts';
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
  let disposeWatcher = (): void => {};
  runWithOwner(null, () => {
    createRoot((dispose) => {
      disposeWatcher = dispose;
      createEffect(
        () => `${packsCollection.state.serverRevision}:${packsCollection.state.optimisticRevision}`,
        (_revisionKey, previousRevisionKey) => {
          if (previousRevisionKey === undefined) return;
          listener();
        },
      );
    });
  });
  flush();
  return disposeWatcher;
}

export { PACKS_TAB_HASH };
export default packsCollection;

import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { PacksStatus } from '#shared/contracts/control/pack-messages.ts';

export const PACKS_TAB_HASH = '#packs';
export const PACK_SOURCE_REPLY_TIMEOUT_MS = 5 * 60_000;

export interface PacksCollectionState {
  status: PacksStatus | null;
  serverRevision: number;
  optimisticRevision: number;
}

export const INITIAL_PACKS_STATE: PacksCollectionState = {
  status: null,
  serverRevision: 0,
  optimisticRevision: 0,
};

export function applyPacksServerMessage(draft: PacksCollectionState, message: ServerMessage): void {
  if (message.type !== 'packs-status') return;
  draft.status = message;
  draft.serverRevision += 1;
}

export function applyOptimisticPackApprove(draft: PacksCollectionState, fingerprint: string): void {
  if (draft.status === null) return;
  const matchingPack = draft.status.packs.find((row) => row.fingerprint === fingerprint && row.state === 'pending');
  if (!matchingPack) return;
  matchingPack.state = 'approved';
  draft.optimisticRevision += 1;
}

export function applyOptimisticPackFolderRemove(draft: PacksCollectionState, dir: string): void {
  if (draft.status === null) return;
  const removedPackNames = new Set<string>();
  for (const row of draft.status.packs) {
    if (row.dir === dir) removedPackNames.add(row.name);
  }
  if (removedPackNames.size === 0) return;
  draft.status.packs = draft.status.packs.filter((row) => row.dir !== dir);
  draft.status.panels = draft.status.panels.filter((panel) => !removedPackNames.has(panel.pack));
  draft.status.launchers = draft.status.launchers.filter((launcher) => !removedPackNames.has(launcher.pack));
  draft.optimisticRevision += 1;
}

export function applyOptimisticPackSourceRemove(draft: PacksCollectionState, slug: string): void {
  if (draft.status === null) return;
  const sourceIndex = draft.status.sources.findIndex((source) => source.slug === slug);
  if (sourceIndex === -1) return;
  const removedSource = draft.status.sources[sourceIndex];
  const sourceEnabledNames = new Set(
    removedSource.packs.filter((pack) => pack.isEnabled).map((pack) => pack.name),
  );
  draft.status.sources.splice(sourceIndex, 1);
  if (sourceEnabledNames.size > 0) {
    const actuallyRemovedPackNames = new Set<string>();
    draft.status.packs = draft.status.packs.filter((row) => {
      if (sourceEnabledNames.has(row.name) && !row.isPlacedByHand) {
        actuallyRemovedPackNames.add(row.name);
        return false;
      }
      return true;
    });
    if (actuallyRemovedPackNames.size > 0) {
      draft.status.panels = draft.status.panels.filter((panel) => !actuallyRemovedPackNames.has(panel.pack));
      draft.status.launchers = draft.status.launchers.filter((launcher) => !actuallyRemovedPackNames.has(launcher.pack));
    }
  }
  draft.optimisticRevision += 1;
}

export function applyOptimisticPackSourceEnable(
  draft: PacksCollectionState,
  slug: string,
  packName: string,
  isEnabled: boolean,
): void {
  if (draft.status === null) return;
  let didChange = false;
  const matchingSource = draft.status.sources.find((source) => source.slug === slug);
  const matchingSourcePack = matchingSource?.packs.find((pack) => pack.name === packName);
  if (matchingSourcePack && matchingSourcePack.isEnabled !== isEnabled) {
    matchingSourcePack.isEnabled = isEnabled;
    didChange = true;
  }
  if (!isEnabled) {
    const previousPackCount = draft.status.packs.length;
    draft.status.packs = draft.status.packs.filter((row) => !(row.name === packName && !row.isPlacedByHand));
    if (draft.status.packs.length !== previousPackCount) {
      draft.status.panels = draft.status.panels.filter((panel) => panel.pack !== packName);
      draft.status.launchers = draft.status.launchers.filter((launcher) => launcher.pack !== packName);
      didChange = true;
    }
  }
  if (didChange) draft.optimisticRevision += 1;
}

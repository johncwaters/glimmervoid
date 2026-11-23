import type { ParentLink } from '#shared/contracts/session.ts';
import { branchParentIdOf } from '#shared/parent-link.ts';
import { setJSON } from '../local-store.ts';

export const SHOWN_REPO_KEY = 'glimmervoid.studio.repoPath';

let openStudio: () => void = () => {};
let showRequestedRepo: (repoPath: string) => void = () => {};

export function isStudioSession(ui: { isStudioMain: boolean; parent: ParentLink | null }): boolean {
  return ui.isStudioMain || branchParentIdOf(ui.parent) !== null;
}

export function setStudioOpener(opener: () => void): void {
  openStudio = opener;
}

export function onStudioRepoRequested(listener: (repoPath: string) => void): void {
  showRequestedRepo = listener;
}

export function openStudioOnRepo(repoPath: string): void {
  setJSON(SHOWN_REPO_KEY, repoPath);
  openStudio();
  showRequestedRepo(repoPath);
}

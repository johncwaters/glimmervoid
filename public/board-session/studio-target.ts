import type { ParentLink } from '#shared/contracts/session.ts';
import { branchParentIdOf } from '#shared/parent-link.ts';

let openStudio: () => void = () => {};

export function isStudioSession(ui: { isStudioMain: boolean; parent: ParentLink | null }): boolean {
  return ui.isStudioMain || branchParentIdOf(ui.parent) !== null;
}

export function setStudioOpener(opener: () => void): void {
  openStudio = opener;
}

export function openStudioTab(): void {
  openStudio();
}

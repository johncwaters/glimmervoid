interface OpenModal {
  overlay: HTMLElement;
  dialog: HTMLElement;
}

const INERT_BY_MODAL = 'modalInert';

export const openModals: OpenModal[] = [];

export function isModalOpen(): boolean {
  return openModals.length > 0;
}

export function syncModalInert(): void {
  const topmost = openModals.at(-1) ?? null;
  const legacyOverlay = topmost && !(topmost.dialog instanceof HTMLDialogElement) ? topmost.overlay : null;
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (legacyOverlay && child !== legacyOverlay && !child.contains(legacyOverlay)) {
      if (child.inert) continue;
      child.inert = true;
      child.dataset[INERT_BY_MODAL] = 'true';
      continue;
    }
    if (child.dataset[INERT_BY_MODAL] !== 'true') continue;
    child.inert = false;
    delete child.dataset[INERT_BY_MODAL];
  }
}

interface OpenModal {
  overlay: HTMLElement;
  dialog: HTMLElement;
}

export const openModals: OpenModal[] = [];

export function isModalOpen(): boolean {
  return openModals.length > 0;
}

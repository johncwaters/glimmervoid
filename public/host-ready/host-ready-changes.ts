const hostReadyChangeListeners = new Set<() => void>();

function onHostReadyChanged(listener: () => void): () => void {
  hostReadyChangeListeners.add(listener);
  return () => { hostReadyChangeListeners.delete(listener); };
}

function announceHostReadyChanged(): void {
  for (const listener of [...hostReadyChangeListeners]) listener();
}

function refreshWhileShown(element: HTMLElement, refresh: () => void): void {
  const stopListening = onHostReadyChanged(() => {
    if (element.isConnected) return refresh();
    stopListening();
  });
}

export { announceHostReadyChanged, refreshWhileShown };

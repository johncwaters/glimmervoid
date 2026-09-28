export type IntegrationSyncOutcome =
  | 'updated'
  | 'up-to-date'
  | 'diverged'
  | 'checked-out'
  | 'no-remote'
  | 'fetch-failed'
  | 'update-failed'
  | 'missing';

export type CheckoutTreeState = 'clean' | 'dirty' | 'unknown';

export interface IntegrationSyncDecision {
  action: 'none' | 'update' | 'update-checkout';
  outcome: IntegrationSyncOutcome;
}

function decideIntegrationSync({
  localSha,
  remoteSha,
  isAncestor,
  checkedOut,
  checkoutTree = 'dirty',
}: {
  localSha: string | null;
  remoteSha: string | null;
  isAncestor: boolean | null | undefined;
  checkedOut: boolean;
  checkoutTree?: CheckoutTreeState;
}): IntegrationSyncDecision {
  if (!remoteSha) return { action: 'none', outcome: 'no-remote' };
  if (!localSha) return { action: 'none', outcome: 'missing' };
  if (localSha === remoteSha) return { action: 'none', outcome: 'up-to-date' };
  if (isAncestor === false) return { action: 'none', outcome: 'diverged' };
  if (isAncestor !== true) return { action: 'none', outcome: 'update-failed' };
  if (!checkedOut) return { action: 'update', outcome: 'updated' };
  if (checkoutTree === 'clean') return { action: 'update-checkout', outcome: 'updated' };
  if (checkoutTree === 'unknown') return { action: 'none', outcome: 'update-failed' };
  return { action: 'none', outcome: 'checked-out' };
}

function classifyRefusedIntegrationSync({
  currentSha,
  remoteSha,
  isAncestor,
  checkoutTree,
}: {
  currentSha: string | null;
  remoteSha: string | null;
  isAncestor: boolean | null | undefined;
  checkoutTree: CheckoutTreeState | null;
}): { outcome: IntegrationSyncOutcome } {
  if (currentSha && currentSha === remoteSha) return { outcome: 'up-to-date' };
  if (isAncestor === false) return { outcome: 'diverged' };
  if (checkoutTree === 'dirty') return { outcome: 'checked-out' };
  return { outcome: 'update-failed' };
}

export { decideIntegrationSync, classifyRefusedIntegrationSync };

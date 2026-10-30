export type IntegrationSyncOutcome =
  | 'updated'
  | 'up-to-date'
  | 'ahead'
  | 'diverged'
  | 'checked-out'
  | 'no-remote'
  | 'fetch-failed'
  | 'update-failed'
  | 'missing';

export type CheckoutTreeState = 'clean' | 'dirty' | 'unknown';

export type BaseAncestry = 'behind' | 'ahead' | 'forked';

interface IntegrationSyncDecision {
  action: 'none' | 'update' | 'update-checkout';
  outcome: IntegrationSyncOutcome;
}

function decideIntegrationSync({
  localSha,
  remoteSha,
  ancestry,
  checkedOut,
  checkoutTree = 'dirty',
}: {
  localSha: string | null;
  remoteSha: string | null;
  ancestry: BaseAncestry | null | undefined;
  checkedOut: boolean;
  checkoutTree?: CheckoutTreeState;
}): IntegrationSyncDecision {
  if (!remoteSha) return { action: 'none', outcome: 'no-remote' };
  if (!localSha) return { action: 'none', outcome: 'missing' };
  if (localSha === remoteSha) return { action: 'none', outcome: 'up-to-date' };
  if (ancestry === 'ahead') return { action: 'none', outcome: 'ahead' };
  if (ancestry === 'forked') return { action: 'none', outcome: 'diverged' };
  if (ancestry !== 'behind') return { action: 'none', outcome: 'update-failed' };
  if (!checkedOut) return { action: 'update', outcome: 'updated' };
  if (checkoutTree === 'clean') return { action: 'update-checkout', outcome: 'updated' };
  if (checkoutTree === 'unknown') return { action: 'none', outcome: 'update-failed' };
  return { action: 'none', outcome: 'checked-out' };
}

function classifyRefusedIntegrationSync({
  currentSha,
  remoteSha,
  ancestry,
  checkoutTree,
}: {
  currentSha: string | null;
  remoteSha: string | null;
  ancestry: BaseAncestry | null | undefined;
  checkoutTree: CheckoutTreeState | null;
}): { outcome: IntegrationSyncOutcome } {
  if (currentSha && currentSha === remoteSha) return { outcome: 'up-to-date' };
  if (ancestry === 'ahead') return { outcome: 'ahead' };
  if (ancestry === 'forked') return { outcome: 'diverged' };
  if (checkoutTree === 'dirty') return { outcome: 'checked-out' };
  return { outcome: 'update-failed' };
}

export { decideIntegrationSync, classifyRefusedIntegrationSync };

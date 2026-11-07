import type { VaultFailure } from '../../../shared/contracts/secrets.ts';

type VaultId = '1password';

interface VaultItemDraft {
  title: string;
  fieldLabel: string;
  value: string;
  vaultName: string;
}

interface VaultSession {
  resolve(reference: string): Promise<string | VaultFailure>;
  create(draft: VaultItemDraft): Promise<{ reference: string } | VaultFailure>;
}

interface VaultAdapter {
  id: VaultId;
  label: string;
  isReference(text: string): boolean;
  open(options: { accountName: string }): Promise<VaultSession | VaultFailure>;
}

const BUILT_IN_VAULTS: readonly VaultAdapter[] = Object.freeze([]);

function vaultAdapterFor(id: VaultId): VaultAdapter | null {
  return BUILT_IN_VAULTS.find((adapter) => adapter.id === id) ?? null;
}

export { vaultAdapterFor };
export type { VaultAdapter, VaultId, VaultSession };

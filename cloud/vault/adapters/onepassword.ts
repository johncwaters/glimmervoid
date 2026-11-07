import type { VaultFailure } from '../../../shared/contracts/secrets.ts';
import type { VaultAdapter, VaultItemDraft, VaultSession } from './index.ts';

const REFERENCE_PREFIX = 'op://';
const INTEGRATION_NAME = 'Glimmervoid vault companion';
const INTEGRATION_VERSION = 'v1';
const DESKTOP_APP_HINT = 'the companion needs the 1Password desktop app installed and unlocked, with Settings > Developer > Integrate with 1Password SDKs turned on';

type OnePasswordClient = Awaited<ReturnType<typeof import('@1password/sdk').createClient>>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureKindOf(error: unknown): VaultFailure['kind'] {
  const message = messageOf(error).toLowerCase();
  if (message.includes('locked') || message.includes('expired')) return 'locked';
  if (message.includes('not found') || message.includes('no item') || message.includes('no vault') || message.includes("isn't an item") || message.includes('no field')) return 'not-found';
  if (message.includes('denied') || message.includes('not authorized') || message.includes('permission')) return 'denied';
  return 'unavailable';
}

function failureOf(error: unknown): VaultFailure {
  return { kind: failureKindOf(error), message: messageOf(error).slice(0, 500) };
}

async function vaultIdByName(client: OnePasswordClient, vaultName: string): Promise<string | VaultFailure> {
  const vaults = await client.vaults.list();
  const matching = vaults.find((vault) => vault.title === vaultName) ?? vaults.find((vault) => vault.title.toLowerCase() === vaultName.toLowerCase());
  if (matching) return matching.id;
  return { kind: 'not-found', message: `1Password has no vault named ${vaultName} that this account can reach` };
}

function concealedReference(item: { id: string; vaultId: string; fields: { id: string; fieldType: string }[] }, concealedType: string): string | null {
  const field = item.fields.find((candidate) => candidate.fieldType === concealedType);
  return field ? `${REFERENCE_PREFIX}${item.vaultId}/${item.id}/${field.id}` : null;
}

async function existingItemReference(client: OnePasswordClient, sdk: typeof import('@1password/sdk'), vaultId: string, title: string): Promise<string | null> {
  const overviews = await client.items.list(vaultId, { type: 'ByState', content: { active: true, archived: false } });
  const matching = overviews.find((overview) => overview.title === title);
  if (!matching) return null;
  return concealedReference(await client.items.get(vaultId, matching.id), sdk.ItemFieldType.Concealed) ?? `${REFERENCE_PREFIX}${vaultId}/${matching.id}`;
}

function sessionFor(client: OnePasswordClient, sdk: typeof import('@1password/sdk')): VaultSession {
  async function resolve(reference: string): Promise<string | VaultFailure> {
    return client.secrets.resolve(reference).catch(failureOf);
  }

  async function create(draft: VaultItemDraft): Promise<{ reference: string } | VaultFailure> {
    try {
      const vaultId = await vaultIdByName(client, draft.vaultName);
      if (typeof vaultId !== 'string') return vaultId;
      const existing = await existingItemReference(client, sdk, vaultId, draft.title);
      if (existing !== null) return { kind: 'denied', message: `1Password already has an item titled ${draft.title} in ${draft.vaultName}; give its reference ${existing} instead of pasting again` };
      const item = await client.items.create({
        category: sdk.ItemCategory.Password,
        vaultId,
        title: draft.title,
        fields: [{ id: 'password', title: draft.fieldLabel, fieldType: sdk.ItemFieldType.Concealed, value: draft.value }],
      });
      const reference = concealedReference(item, sdk.ItemFieldType.Concealed);
      if (reference === null) return { kind: 'unavailable', message: '1Password created the item without its concealed field' };
      return { reference };
    } catch (error) {
      return failureOf(error);
    }
  }

  return { resolve, create };
}

const onePasswordAdapter: VaultAdapter = {
  id: '1password',
  label: '1Password',
  isReference: (text) => text.startsWith(REFERENCE_PREFIX),
  async open({ accountName }) {
    if (accountName === '') return { kind: 'unavailable', message: 'pass --account with your 1Password account name (the name shown at the top of the 1Password app sidebar)' };
    try {
      const sdk = await import('@1password/sdk');
      const client = await sdk.createClient({ auth: new sdk.DesktopAuth(accountName), integrationName: INTEGRATION_NAME, integrationVersion: INTEGRATION_VERSION });
      return sessionFor(client, sdk);
    } catch (error) {
      const failure = failureOf(error);
      return { kind: failure.kind, message: `${failure.message}; ${DESKTOP_APP_HINT}` };
    }
  },
};

export { onePasswordAdapter };

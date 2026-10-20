import { cachedAgentResolvability } from '../session/adapters/index.ts';
import type { CoderEnvironmentOffer, CustomAgentDeclaration, CustomAgentSummaryRow, TelegramDeliveryStatus } from '../shared/contracts/index.ts';
import { getRtkPath } from './rtk-resolver.ts';
import { resolvePackageBin } from './runtime-paths.ts';

interface SettingsPayloadOptions {
  configStore: {
    getSettings: () => Record<string, unknown>;
    config: { customAgents?: CustomAgentDeclaration[] };
  };
  rtkInstallStatus?: Record<string, unknown> | null;
  telegramDelivery?: TelegramDeliveryStatus | null;
  coderEnvironments?: CoderEnvironmentOffer[] | null;
  resolveRtk?: () => string | null;
}

function summarizeCustomAgents(declarations: readonly CustomAgentDeclaration[]): CustomAgentSummaryRow[] {
  return declarations.map((declaration) => ({
    id: declaration.id,
    label: declaration.label,
    command: declaration.command,
    args: [...declaration.args],
    resolvable: cachedAgentResolvability(declaration.id).resolvable,
  }));
}

function buildSettingsPayload({
  configStore, rtkInstallStatus = null, telegramDelivery = null, coderEnvironments = null, resolveRtk = getRtkPath,
}: SettingsPayloadOptions): Record<string, unknown> {
  return {
    ...configStore.getSettings(),
    rtkAvailable: !!resolveRtk(),
    saneYoloAvailable: !!resolvePackageBin('cc-safety-net', 'cc-safety-net'),
    rtkInstall: rtkInstallStatus || { status: 'idle' },
    customAgents: summarizeCustomAgents(configStore.config.customAgents ?? []),
    telegramDelivery,
    coderEnvironments,
  };
}

export { buildSettingsPayload };

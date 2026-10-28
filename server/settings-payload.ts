import { cachedAgentResolvability } from '../session/adapters/index.ts';
import type { AgentLoginStatus, CoderEnvironmentOffer, CustomAgentDeclaration, CustomAgentSummaryRow, TelegramDeliveryStatus } from '../shared/contracts/index.ts';
import type { TeamReviewEnvironment } from '../shared/contracts/team-review-environment.ts';
import type { TeamReviewSettingsSource } from './github/core/team-review-core.ts';
import { currentTeamReviewEnvironment } from './github/team-review-environment.ts';
import { getRtkPath } from './rtk-resolver.ts';
import { resolvePackageBin } from './runtime-paths.ts';

interface SettingsPayloadOptions {
  configStore: {
    getSettings: () => Record<string, unknown>;
    config: { customAgents?: CustomAgentDeclaration[] } & Partial<TeamReviewSettingsSource>;
    isExperimentalBuild?: boolean;
  };
  rtkInstallStatus?: Record<string, unknown> | null;
  telegramDelivery?: TelegramDeliveryStatus | null;
  coderEnvironments?: CoderEnvironmentOffer[] | null;
  agentLogins?: AgentLoginStatus[] | null;
  resolveRtk?: () => string | null;
  readTeamReviewEnvironment?: (settingsSource: Partial<TeamReviewSettingsSource>) => TeamReviewEnvironment;
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
  configStore, rtkInstallStatus = null, telegramDelivery = null, coderEnvironments = null, agentLogins = null, resolveRtk = getRtkPath, readTeamReviewEnvironment = currentTeamReviewEnvironment,
}: SettingsPayloadOptions): Record<string, unknown> {
  return {
    ...configStore.getSettings(),
    isExperimentalBuild: configStore.isExperimentalBuild === true,
    rtkAvailable: !!resolveRtk(),
    saneYoloAvailable: !!resolvePackageBin('cc-safety-net', 'cc-safety-net'),
    rtkInstall: rtkInstallStatus || { status: 'idle' },
    customAgents: summarizeCustomAgents(configStore.config.customAgents ?? []),
    telegramDelivery,
    coderEnvironments,
    agentLogins,
    teamReviewEnvironment: readTeamReviewEnvironment(configStore.config),
  };
}

export { buildSettingsPayload };

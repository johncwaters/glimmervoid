import { cachedAgentResolvability } from '../session/adapters/index.ts';
import type { AgentLoginStatus, CoderEnvironmentOffer, CustomAgentDeclaration, CustomAgentSummaryRow, TelegramDeliveryStatus } from '../shared/contracts/index.ts';
import type { TeamReviewEnvironment } from '../shared/contracts/team-review-environment.ts';
import type { TeamReviewSettingsSource } from './github/core/team-review-core.ts';
import { currentTeamReviewEnvironment } from './github/team-review-environment.ts';
import { currentAgentModelCatalog } from './agent-models/agent-models.ts';
import type { AgentModelCatalog } from '../shared/contracts/agent-models.ts';
import { resolvePackageBin } from './runtime-paths.ts';

interface SettingsPayloadOptions {
  configStore: {
    getSettings: () => Record<string, unknown>;
    config: { customAgents?: CustomAgentDeclaration[] } & Partial<TeamReviewSettingsSource>;
    isExperimentalBuild?: boolean;
  };
  telegramDelivery?: TelegramDeliveryStatus | null;
  coderEnvironments?: CoderEnvironmentOffer[] | null;
  agentLogins?: AgentLoginStatus[] | null;
  readTeamReviewEnvironment?: () => TeamReviewEnvironment;
  readAgentModels?: () => AgentModelCatalog;
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
  configStore, telegramDelivery = null, coderEnvironments = null, agentLogins = null, readTeamReviewEnvironment = currentTeamReviewEnvironment, readAgentModels = currentAgentModelCatalog,
}: SettingsPayloadOptions): Record<string, unknown> {
  return {
    ...configStore.getSettings(),
    isExperimentalBuild: configStore.isExperimentalBuild === true,
    saneYoloAvailable: !!resolvePackageBin('cc-safety-net', 'cc-safety-net'),
    customAgents: summarizeCustomAgents(configStore.config.customAgents ?? []),
    telegramDelivery,
    coderEnvironments,
    agentLogins,
    teamReviewEnvironment: readTeamReviewEnvironment(),
    agentModels: readAgentModels(),
  };
}

export { buildSettingsPayload };

import { TeamReviewEnvironment } from '#shared/contracts/team-review-environment.ts';
import type { ReviewAgentOffer, TeamReviewSandboxFacts } from '#shared/contracts/team-review-environment.ts';

interface SettingsSuggestion { value: string; label: string }
type StoredValues = Readonly<Record<string, unknown>>;

const REVIEWER_AGENT_PATH = 'teamReview.reviewer.agent';
const REVIEWER_MODEL_PATH = 'teamReview.reviewer.model';
const STAMP_AGENT_PATH = 'teamReview.stampReviewer.agent';
const STAMP_MODEL_PATH = 'teamReview.stampReviewer.model';
const DEFAULT_REVIEW_AGENT = 'claude';

function readTeamReviewEnvironment(payloadValue: unknown): TeamReviewEnvironment | null {
  const parsed = TeamReviewEnvironment.safeParse(payloadValue);
  return parsed.success ? parsed.data : null;
}

function textAt(values: StoredValues, settingPath: string): string {
  const value = values[settingPath];
  return typeof value === 'string' ? value.trim() : '';
}

function reviewerAgentId(values: StoredValues): string {
  return textAt(values, REVIEWER_AGENT_PATH) || DEFAULT_REVIEW_AGENT;
}

function stampAgentId(values: StoredValues): string {
  return textAt(values, STAMP_AGENT_PATH) || reviewerAgentId(values);
}

function agentOffer(environment: TeamReviewEnvironment, agentId: string): ReviewAgentOffer | null {
  return environment.agents.find((agent) => agent.id === agentId) ?? null;
}

function modelSuggestions(agent: ReviewAgentOffer | null): SettingsSuggestion[] {
  return (agent?.models ?? []).map((model) => ({ value: model.id, label: model.label }));
}

function effortSuggestions(agent: ReviewAgentOffer | null, modelId: string): SettingsSuggestion[] {
  if (!agent) return [];
  const model = agent.models.find((candidate) => candidate.id === modelId);
  const efforts = model?.efforts ?? agent.efforts;
  return efforts.map((effort) => ({ value: effort, label: effort === model?.defaultEffort ? `${effort} (model default)` : effort }));
}

function skillSuggestions(agent: ReviewAgentOffer | null): SettingsSuggestion[] {
  return (agent?.skills ?? []).map((skill) => ({ value: skill.name, label: skill.description }));
}

const SUGGESTION_CATALOGS: Readonly<Record<string, (environment: TeamReviewEnvironment, values: StoredValues) => SettingsSuggestion[]>> = Object.freeze({
  'review-skills': (environment, values) => skillSuggestions(agentOffer(environment, reviewerAgentId(values))),
  'review-models': (environment, values) => modelSuggestions(agentOffer(environment, reviewerAgentId(values))),
  'review-efforts': (environment, values) => effortSuggestions(agentOffer(environment, reviewerAgentId(values)), textAt(values, REVIEWER_MODEL_PATH)),
  'review-stamp-models': (environment, values) => modelSuggestions(agentOffer(environment, stampAgentId(values))),
  'review-stamp-efforts': (environment, values) => effortSuggestions(agentOffer(environment, stampAgentId(values)), textAt(values, STAMP_MODEL_PATH)),
});

function teamReviewSuggestions(catalogName: string, environment: TeamReviewEnvironment | null, values: StoredValues): SettingsSuggestion[] {
  const catalog = SUGGESTION_CATALOGS[catalogName];
  if (!catalog || !environment) return [];
  return catalog(environment, values);
}

function isReviewAgentOffered(environment: TeamReviewEnvironment | null, agentId: string): boolean {
  if (agentId === '' || !environment) return true;
  return agentOffer(environment, agentId)?.installed !== false;
}

function isSkillChoicePending(teamReviewBlock: unknown): boolean {
  if (!teamReviewBlock || typeof teamReviewBlock !== 'object') return true;
  return typeof (teamReviewBlock as Record<string, unknown>).skill !== 'string';
}

function listOrNone(entries: readonly string[]): string {
  return entries.length > 0 ? entries.join(', ') : 'none';
}

function teamReviewSandboxLines(sandbox: TeamReviewSandboxFacts): string[] {
  const network = sandbox.networkOpen
    ? 'Network: open, any address including this machine'
    : `Network: allowlist, the agent API (${listOrNone(sandbox.agentApiDomains)}) plus ${listOrNone(sandbox.networkDomains)}`;
  return [
    network,
    `MCP servers: ${sandbox.mcpLoaded ? 'your own servers load' : 'none load'}`,
    `Unreadable in your home folder: ${listOrNone(sandbox.unreadableHomeEntries.map((entry) => `~/${entry}`))}`,
    `Unreadable in a linked checkout: ${listOrNone(sandbox.unreadableCheckoutEntries)}`,
    `GitHub token: ${sandbox.githubTokenStripped ? 'removed from the environment' : 'passed through'}`,
    `Claude Code tools allowed: ${listOrNone(sandbox.allowedTools)}; denied: ${listOrNone(sandbox.deniedTools)}. Codex CLI and Kimi Code run every tool, held only by this sandbox`,
    `Thread replies: judged by the review agent, with ${listOrNone(sandbox.threadJudgeTools)} only on Claude Code`,
  ];
}

export { isReviewAgentOffered, isSkillChoicePending, readTeamReviewEnvironment, teamReviewSandboxLines, teamReviewSuggestions };

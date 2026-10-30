import { TeamReviewEnvironment } from '#shared/contracts/team-review-environment.ts';
import type { ReviewAgentOffer } from '#shared/contracts/team-review-environment.ts';

interface SettingsSuggestion { value: string; label: string }
type StoredValues = Readonly<Record<string, unknown>>;

const REVIEWER_MODEL_PATH = 'teamReview.reviewer.model';
const STAMP_MODEL_PATH = 'teamReview.stampReviewer.model';

function readTeamReviewEnvironment(payloadValue: unknown): TeamReviewEnvironment | null {
  const parsed = TeamReviewEnvironment.safeParse(payloadValue);
  return parsed.success ? parsed.data : null;
}

function textAt(values: StoredValues, settingPath: string): string {
  const value = values[settingPath];
  return typeof value === 'string' ? value.trim() : '';
}

function reviewAgentOffer(environment: TeamReviewEnvironment): ReviewAgentOffer | null {
  return environment.agents.at(0) ?? null;
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
  'review-skills': (environment) => skillSuggestions(reviewAgentOffer(environment)),
  'review-models': (environment) => modelSuggestions(reviewAgentOffer(environment)),
  'review-efforts': (environment, values) => effortSuggestions(reviewAgentOffer(environment), textAt(values, REVIEWER_MODEL_PATH)),
  'review-stamp-models': (environment) => modelSuggestions(reviewAgentOffer(environment)),
  'review-stamp-efforts': (environment, values) => effortSuggestions(reviewAgentOffer(environment), textAt(values, STAMP_MODEL_PATH)),
});

function teamReviewSuggestions(catalogName: string, environment: TeamReviewEnvironment | null, values: StoredValues): SettingsSuggestion[] {
  const catalog = SUGGESTION_CATALOGS[catalogName];
  if (!catalog || !environment) return [];
  return catalog(environment, values);
}

function isSkillChoicePending(teamReviewBlock: unknown): boolean {
  if (!teamReviewBlock || typeof teamReviewBlock !== 'object') return true;
  return typeof (teamReviewBlock as Record<string, unknown>).skill !== 'string';
}

export { isSkillChoicePending, readTeamReviewEnvironment, teamReviewSuggestions };

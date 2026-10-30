import type { GithubTeam } from '#shared/contracts/control-messages.ts';
import { repoParts } from '#shared/contracts/github-ids.ts';

type SetupStepState = 'done' | 'current' | 'upcoming';

interface ReviewSetupSteps { github: SetupStepState; teams: SetupStepState; skill: SetupStepState }

interface GithubTeamOption { entry: string; label: string }

function decideReviewSetupSteps(viewerLogin: string | null): ReviewSetupSteps {
  if (!viewerLogin) return { github: 'current', teams: 'upcoming', skill: 'upcoming' };
  return { github: 'done', teams: 'current', skill: 'upcoming' };
}

function teamOptionsOf(listedTeams: readonly GithubTeam[]): GithubTeamOption[] {
  return listedTeams.map((team) => ({ entry: `${team.org}/${team.slug}`, label: team.name }));
}

function teamsToSave(checkedEntries: ReadonlySet<string>, typedText: string): string[] | null {
  const typedEntry = typedText.trim();
  if (typedEntry && !repoParts(typedEntry)) return null;
  const entries = new Set(checkedEntries);
  if (typedEntry) entries.add(typedEntry);
  return [...entries];
}

export { decideReviewSetupSteps, teamOptionsOf, teamsToSave };
export type { GithubTeamOption, ReviewSetupSteps, SetupStepState };

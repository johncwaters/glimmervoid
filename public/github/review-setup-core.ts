import type { GithubTeam } from '#shared/contracts/control-messages.ts';
import { GH_SEGMENT, repoParts } from '#shared/contracts/github-ids.ts';

type SetupStepState = 'done' | 'current' | 'upcoming';

interface ReviewSetupSteps { github: SetupStepState; readToken: SetupStepState; teams: SetupStepState; skill: SetupStepState }

interface GithubTeamOption { entry: string; label: string }

function decideReviewSetupSteps(viewerLogin: string | null, hasReadToken: boolean): ReviewSetupSteps {
  if (!viewerLogin) return { github: 'current', readToken: hasReadToken ? 'done' : 'upcoming', teams: 'upcoming', skill: 'upcoming' };
  if (!hasReadToken) return { github: 'done', readToken: 'current', teams: 'upcoming', skill: 'upcoming' };
  return { github: 'done', readToken: 'done', teams: 'current', skill: 'upcoming' };
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

function orgToSave(selectedOrg: string, typedText: string): string | null {
  const org = typedText.trim() || selectedOrg;
  return GH_SEGMENT.test(org) ? org : null;
}

export { decideReviewSetupSteps, orgToSave, teamOptionsOf, teamsToSave };

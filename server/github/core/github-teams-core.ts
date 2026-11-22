import type { Config } from '../../../shared/contracts/config.ts';
import { repoParts } from '../../../shared/contracts/github-ids.ts';

export function readGithubTeams(config: Pick<Config, 'github'>): Array<{ org: string; slug: string }> {
  const configuredTeams = config.github?.teams;
  if (!configuredTeams?.length) return [];

  const teamsByName = new Map<string, { org: string; slug: string }>();
  for (const teamName of configuredTeams) {
    const parts = repoParts(teamName);
    if (!parts) continue;
    const [org, slug] = parts;
    const teamKey = teamName.toLowerCase();
    if (!teamsByName.has(teamKey)) teamsByName.set(teamKey, { org, slug });
  }
  return [...teamsByName.values()];
}

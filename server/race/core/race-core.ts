import type { RaceContestant, RaceSpec } from '../../../shared/contracts/race.ts';

const SESSION_NAME_MAX_CHARS = 64;
const SESSION_NAME_UNSAFE_CHARS = /[^a-zA-Z0-9_\-. ()]+/g;

function contestantPrompt(spec: RaceSpec, contestant: RaceContestant): string {
  const instructions = contestant.setup.instructions.trim();
  return instructions === '' ? spec.prompt : `${spec.prompt}\n\n${instructions}`;
}

function contestantSessionName(spec: RaceSpec, contestant: RaceContestant): string {
  const name = `${spec.title} (${contestant.label})`.replace(SESSION_NAME_UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return name.slice(0, SESSION_NAME_MAX_CHARS).trim() || contestant.id;
}

function raceIdsOf(projects: readonly { raceId?: string }[]): string[] {
  return [...new Set(projects.flatMap((project) => (project.raceId ? [project.raceId] : [])))];
}

export { contestantPrompt, contestantSessionName, raceIdsOf };

import type { RaceRecord } from '#shared/contracts/race.ts';

let races: readonly RaceRecord[] = [];
const subscribers = new Set<() => void>();

export function subscribeRaces(subscriber: () => void): void {
  subscribers.add(subscriber);
}

export function raceList(): readonly RaceRecord[] {
  return races;
}

export function applyRaceStatus(message: { races: RaceRecord[] }): void {
  races = message.races;
  for (const subscriber of subscribers) subscriber();
}

export function raceGroupOf(row: { id: string }): { key: string; label: string; title: string } | null {
  const race = raceOfSession(row.id);
  return race ? { key: `race:${race.id}`, label: race.spec.title, title: `Race: ${race.spec.title}` } : null;
}

function raceOfSession(sessionId: string): RaceRecord | null {
  return races.find((race) => Object.values(race.sessionIdByContestant).includes(sessionId)) ?? null;
}

let openTerminal: (sessionId: string) => void = () => {};

export function setArenaNavigation(navigation: { openTerminal: (sessionId: string) => void }): void {
  openTerminal = navigation.openTerminal;
}

export function openRaceSession(sessionId: string): void {
  openTerminal(sessionId);
}

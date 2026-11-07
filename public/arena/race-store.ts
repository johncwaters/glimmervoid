import type { RaceHistory, RaceRecord } from '#shared/contracts/race.ts';
import { REMOVED_CONTESTANT, raceProgress } from '#shared/race-core.ts';
import { sessionUIs } from '../session-card/card-registry.ts';

let races: readonly RaceRecord[] = [];
let history: RaceHistory | null = null;
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

export function raceHistory(): RaceHistory | null {
  return history;
}

export function applyRaceHistory(message: { history: RaceHistory }): void {
  history = message.history;
  for (const subscriber of subscribers) subscriber();
}

export function raceGroupOf(row: { id: string }): { key: string; label: string; title: string } | null {
  const race = raceOfSession(row.id);
  if (!race) return null;
  const progress = raceProgress(Object.values(race.sessionIdByContestant), (sessionId) => sessionUIs.get(sessionId)?.currentState ?? REMOVED_CONTESTANT);
  return { key: `race:${race.id}`, label: `${race.spec.title} ${progress.settled}/${progress.total}`, title: `Race: ${race.spec.title}, ${progress.settled} of ${progress.total} settled` };
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

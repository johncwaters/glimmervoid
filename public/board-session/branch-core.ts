import type { ParentLink } from '#shared/contracts/session.ts';
import { branchParentIdOf } from '#shared/parent-link.ts';

export interface BoxChoice {
  boxId: string;
  title: string;
  repoName: string;
}

export interface BoxMention {
  start: number;
  end: number;
  query: string;
}

export type DockAddress =
  | { kind: 'main' }
  | { kind: 'new-branch'; aboutBoxId: string; aboutTitle: string }
  | { kind: 'branch'; sessionId: string; aboutTitle: string };

const MAX_BOX_CHOICES = 8;
const MENTION_BEFORE_CARET = /(?:^|\s)@([^\s@]*)$/;

export function boxMentionAt(text: string, caret: number): BoxMention | null {
  const match = MENTION_BEFORE_CARET.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, end: caret, query };
}

export function textWithoutMention(text: string, mention: BoxMention): string {
  return `${text.slice(0, mention.start)}${text.slice(mention.end)}`.replace(/\s{2,}/g, ' ').trimStart();
}

export function placeTitleOf(repoName: string, boxTitle: string): string {
  return `${repoName} ${boxTitle}`;
}

export function matchingBoxChoices(choices: readonly BoxChoice[], query: string): BoxChoice[] {
  const needle = query.toLowerCase();
  const rankOf = (choice: BoxChoice) => {
    const title = choice.title.toLowerCase();
    if (title.startsWith(needle)) return 0;
    const lastSegment = title.slice(title.lastIndexOf('/') + 1);
    if (lastSegment.startsWith(needle)) return 1;
    if (title.includes(needle)) return 2;
    return 3;
  };
  const firstChoiceByPlace = new Map<string, BoxChoice>();
  for (const choice of choices) {
    const place = `${choice.repoName}/${choice.title}`;
    if (!firstChoiceByPlace.has(place)) firstChoiceByPlace.set(place, choice);
  }
  const bestChoices = [...firstChoiceByPlace]
    .filter(([place]) => place.toLowerCase().includes(needle))
    .map(([, choice]) => choice)
    .sort((left, right) => rankOf(left) - rankOf(right) || left.title.length - right.title.length || left.title.localeCompare(right.title))
    .slice(0, MAX_BOX_CHOICES);
  const repoNames = [...new Set(bestChoices.map((choice) => choice.repoName))];
  return repoNames.flatMap((repoName) => bestChoices.filter((choice) => choice.repoName === repoName));
}

export function branchSessionIdsOf(sessions: Iterable<[string, { parent: ParentLink | null }]>, parentId: string): string[] {
  const branchIds: string[] = [];
  for (const [sessionId, session] of sessions) {
    if (branchParentIdOf(session.parent) === parentId) branchIds.push(sessionId);
  }
  return branchIds;
}

export function addressLabelOf(address: DockAddress): string {
  if (address.kind === 'new-branch') return `New branch on ${address.aboutTitle}`;
  if (address.kind === 'branch') return `To ${address.aboutTitle}`;
  return '';
}

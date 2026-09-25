import { FindingSeverity } from './contracts/team-review.ts';

export const AUTOMATED_REVIEW_NOTE = '> [!NOTE]\n> Automated review. Not written by a human.';

const SEVERITY_ALTERNATION = FindingSeverity.options.join('|');
const FINDING_HEADER_SOURCE = String.raw`\*\*\[([^\]\n]+)\]\s+(${SEVERITY_ALTERNATION})\*\*`;

export function findingHeader(reviewer: string, severity: FindingSeverity): string {
  return `**[${reviewer}] ${severity}**`;
}

export function findingSeveritiesIn(body: string): FindingSeverity[] {
  return [...body.matchAll(new RegExp(FINDING_HEADER_SOURCE, 'g'))].flatMap((match) => {
    const severity = FindingSeverity.safeParse(match[2]);
    return severity.success ? [severity.data] : [];
  });
}

export function parseLeadingFindingHeader(body: string): { reviewer: string; severity: FindingSeverity; length: number } | null {
  const match = new RegExp(String.raw`^${FINDING_HEADER_SOURCE}\s*(?:\r?\n|$)`).exec(body);
  if (!match) return null;
  const severity = FindingSeverity.safeParse(match[2]);
  if (!severity.success) return null;
  return { reviewer: match[1] ?? '', severity: severity.data, length: match[0].length };
}

export function withoutAutomatedNote(body: string): string {
  const trimmed = body.trimStart();
  return trimmed.startsWith(AUTOMATED_REVIEW_NOTE) ? trimmed.slice(AUTOMATED_REVIEW_NOTE.length).trim() : body.trim();
}

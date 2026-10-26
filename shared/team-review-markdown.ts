import { FindingSeverity } from './contracts/team-review.ts';
import type { ReviewFinding } from './contracts/team-review.ts';

export const AUTOMATED_REVIEW_NOTE = '> [!NOTE]\n> Automated review. Not written by a human.';
export const CREDITED_REVIEW_NOTE = '> [!NOTE]\n> Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human.';
export const HAND_APPROVED_REVIEW_NOTE = '> [!NOTE]\n> Automated review by [Glimmervoid](https://glimmervoid.dev), not written by a human. Approved by hand after checking it.';

const SEVERITY_ALTERNATION = FindingSeverity.options.join('|');
const FINDING_HEADER_SOURCE = String.raw`\*\*(?:\[([^\]\n]+)\]\s+)?(${SEVERITY_ALTERNATION})\*\*`;

export function findingHeader(reviewer: string, severity: FindingSeverity): string {
  return `**[${reviewer}] ${severity}**`;
}

export function findingSeveritiesIn(body: string): FindingSeverity[] {
  return [...body.matchAll(new RegExp(FINDING_HEADER_SOURCE, 'g'))].flatMap((match) => {
    const severity = FindingSeverity.safeParse(match[2]);
    return severity.success ? [severity.data] : [];
  });
}

export function parseLeadingFindingHeader(body: string): { reviewer: string | null; severity: FindingSeverity; length: number } | null {
  const match = new RegExp(String.raw`^${FINDING_HEADER_SOURCE}\s*(?:\r?\n|$)`).exec(body);
  if (!match) return null;
  const severity = FindingSeverity.safeParse(match[2]);
  if (!severity.success) return null;
  return { reviewer: match[1] ?? null, severity: severity.data, length: match[0].length };
}

export function withoutAutomatedNote(body: string): string {
  const trimmed = body.trimStart();
  const leadingNote = [AUTOMATED_REVIEW_NOTE, CREDITED_REVIEW_NOTE, HAND_APPROVED_REVIEW_NOTE].find((note) => trimmed.startsWith(note));
  return leadingNote ? trimmed.slice(leadingNote.length).trim() : body.trim();
}

export interface GeneralFinding {
  severity: FindingSeverity | null;
  location: string | null;
  body: string;
  markdown: string;
}

const FOLDED_FINDING_MARKER = '(line not in the diff)';
const FINDING_BULLET_SOURCE = String.raw`- ${FINDING_HEADER_SOURCE}`;
const FOLDED_FINDING_SOURCE = String.raw`\*\*\x60([^\x60\n]+)\x60\*\* ${FOLDED_FINDING_MARKER.replace(/[()]/g, '\\$&')}`;
const GENERAL_FINDING_START = new RegExp(String.raw`^(?:${FINDING_BULLET_SOURCE}|${FOLDED_FINDING_SOURCE})`, 'gm');
const FINDING_BULLET = new RegExp(String.raw`^${FINDING_BULLET_SOURCE}\s*(?:\x60([^\x60\n]+)\x60:\s*)?`);
const FOLDED_FINDING = new RegExp(String.raw`^${FOLDED_FINDING_SOURCE}\s*`);

export function strongestFindingSeverity(severities: readonly FindingSeverity[]): FindingSeverity | null {
  return FindingSeverity.options.find((severity) => severities.includes(severity)) ?? null;
}

export function foldedFindingSection(path: string, line: number, body: string): string {
  return `**\`${path}:${line}\`** ${FOLDED_FINDING_MARKER}\n\n${body}`;
}

export function generalFindingBullet(finding: Pick<ReviewFinding, 'reviewer' | 'severity' | 'path' | 'line' | 'body'>): string {
  const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
  return `- ${findingHeader(finding.reviewer, finding.severity)} \`${location}\`: ${finding.body}`;
}

function generalFindingFrom(markdown: string): GeneralFinding {
  const bullet = FINDING_BULLET.exec(markdown);
  if (bullet) return { severity: FindingSeverity.parse(bullet[2]), location: bullet[3] ?? null, body: markdown.slice(bullet[0].length).trim(), markdown };
  const folded = FOLDED_FINDING.exec(markdown);
  const body = folded ? markdown.slice(folded[0].length).trim() : markdown;
  return { severity: strongestFindingSeverity(findingSeveritiesIn(body)), location: folded?.[1] ?? null, body, markdown };
}

export function generalPreambleOf(reviewBody: string): string {
  const content = withoutAutomatedNote(reviewBody);
  const firstFindingStart = content.search(GENERAL_FINDING_START);
  return (firstFindingStart === -1 ? content : content.slice(0, firstFindingStart)).trim();
}

export function generalFindingsOf(reviewBody: string): GeneralFinding[] {
  const content = withoutAutomatedNote(reviewBody);
  const starts = [...content.matchAll(GENERAL_FINDING_START)].map((match) => match.index);
  return starts.map((start, index) => content.slice(start, starts[index + 1]).trim()).filter(Boolean).map(generalFindingFrom);
}

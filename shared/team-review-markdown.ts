import { FindingSeverity } from './contracts/team-review.ts';
import type { ReviewFinding } from './contracts/team-review.ts';

const AUTOMATED_NOTE_TEXT = 'Automated review. Not written by a human.';
const CREDITED_NOTE_TEXT = 'Automated review by [Glimmervoid](https://glimmervoid.dev). Not written by a human.';
const HAND_APPROVED_NOTE_TEXT = 'Automated review by [Glimmervoid](https://glimmervoid.dev), not written by a human. Approved by hand after checking it.';
const NOTE_TEXTS = [AUTOMATED_NOTE_TEXT, CREDITED_NOTE_TEXT, HAND_APPROVED_NOTE_TEXT];

const footerNote = (text: string): string => `<sub>${text.replace(/\.$/, '')}</sub>`;
const earlierNoteStyles = [(text: string): string => `> [!NOTE]\n> ${text}`, (text: string): string => `> **Obligatory Agent Disclaimer:**\n>\n> ${text}`];
const EVERY_NOTE = [...NOTE_TEXTS.map(footerNote), ...earlierNoteStyles.flatMap((noteStyle) => NOTE_TEXTS.map(noteStyle))];

export const AUTOMATED_REVIEW_NOTE = footerNote(AUTOMATED_NOTE_TEXT);
export const CREDITED_REVIEW_NOTE = footerNote(CREDITED_NOTE_TEXT);
export const HAND_APPROVED_REVIEW_NOTE = footerNote(HAND_APPROVED_NOTE_TEXT);

export function hasAutomatedNote(body: string): boolean {
  return EVERY_NOTE.some((note) => body.includes(note));
}

export function withoutAutomatedNote(body: string): string {
  return EVERY_NOTE.reduce((remaining, note) => remaining.replaceAll(`${note}\n\n`, '').replaceAll(note, ''), body).trim();
}

function withOpenBlocksClosed(body: string): string {
  const openFence = body.split('\n').reduce<string | null>((open, line) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (!fence) return open;
    if (open === null) return fence;
    return fence[0] === open[0] && fence.length >= open.length && line.trim() === fence ? null : open;
  }, null);
  const unclosedDetailsCount = (body.match(/<details\b/gi)?.length ?? 0) - (body.match(/<\/details>/gi)?.length ?? 0);
  return [body, openFence ?? '', '</details>'.repeat(Math.max(0, unclosedDetailsCount))].filter(Boolean).join('\n');
}

export function withAutomatedNote(body: string, note: string = AUTOMATED_REVIEW_NOTE): string {
  return [withOpenBlocksClosed(withoutAutomatedNote(body)), note].filter(Boolean).join('\n\n');
}

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

import { COMPACT_FLOORED_AGO, elapsedText } from '#shared/display-text.ts';
import type { ActivityEvent, VisionsComment, VisionsFinding } from './visions-store-core.ts';

export { commentLineLabel, findingLineLabel, fixLineLabel, fixOutcomeText, intentRows } from './visions-store-core.ts';
export type { ActivityEvent, IntentRow, VisionsComment, VisionsFinding, VisionsFixEntry } from './visions-store-core.ts';

export const VISIONS_EMPTY_TEXT = 'No findings. Open a markdown file in a connected editor.';

export interface VisionsSection {
  uri: string;
  name: string;
  hand: string | null;
  findings: VisionsFinding[];
  comments: VisionsComment[];
}

function characterOf(finding: VisionsFinding | null | undefined) {
  const character = Number(finding?.range?.start?.character);
  return Number.isFinite(character) ? character : 0;
}

function lineOf(finding: VisionsFinding | null | undefined) {
  const line = Number(finding?.range?.start?.line);
  return Number.isFinite(line) ? line : 0;
}

export function basenameOfUri(uri: unknown) {
  const text = typeof uri === 'string' ? uri : '';
  if (!text) return '';
  const lastSlash = text.lastIndexOf('/');
  const tail = lastSlash === -1 ? text : text.slice(lastSlash + 1);
  if (!tail) return text;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function boundedCount(count: unknown) {
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 0;
}

function findingCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 finding' : `${total} findings`;
}

export function commentCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 comment' : `${total} comments`;
}

export function sectionCountText(section: Partial<VisionsSection> | null | undefined) {
  const findings = boundedCount(section?.findings?.length);
  const comments = boundedCount(section?.comments?.length);
  const hand = typeof section?.hand === 'string' && section.hand ? 1 : 0;
  const parts: string[] = [];
  if (hand > 0) parts.push('raised hand');
  if (findings > 0) parts.push(findingCountText(findings));
  if (comments > 0) parts.push(commentCountText(comments));
  if (parts.length > 0) return parts.join(', ');
  return findingCountText(0);
}

export function visionsHandText(hand: unknown) {
  const text = typeof hand === 'string' ? hand.trim() : '';
  if (!text) return '';
  return `Raised hand: ${text}`;
}

export function visionsSections(
  findingsByUri: Map<string, VisionsFinding[]>,
  commentsByUri: Map<string, VisionsComment[]> = new Map(),
  handsByUri: Map<string, string> = new Map()
): VisionsSection[] {
  const sections: VisionsSection[] = [];
  const uris = new Set([...findingsByUri.keys(), ...commentsByUri.keys(), ...handsByUri.keys()]);
  for (const uri of uris) {
    const diagnostics = findingsByUri.get(uri);
    const comments = commentsByUri.get(uri);
    const hand = handsByUri.get(uri) || null;
    const findings: VisionsFinding[] = Array.isArray(diagnostics) ? diagnostics : [];
    const modelComments: VisionsComment[] = Array.isArray(comments) ? comments : [];
    if (findings.length === 0 && modelComments.length === 0 && !hand) continue;
    sections.push({
      uri,
      name: basenameOfUri(uri) || uri,
      hand,
      findings: [...findings].sort((a, b) => lineOf(a) - lineOf(b) || characterOf(a) - characterOf(b)),
      comments: [...modelComments].sort((a, b) => (Number(a?.line) || 0) - (Number(b?.line) || 0)),
    });
  }
  sections.sort((a, b) => compareText(a.name, b.name) || compareText(a.uri, b.uri));
  return sections;
}

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export const VISIONS_FIXES_EMPTY_TEXT = 'No fixes yet. Silent fixes appear here once the lane applies or is refused one.';

export function fixCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 fix' : `${total} fixes`;
}

export const INGEST_EMPTY_TEXT = 'No activity yet. The ingest lane reports what your sessions and tools are doing.';

const SOURCE_LABELS: Record<string, string> = {
  terminal: 'terminal',
  agentLogs: 'agent',
  git: 'git',
  fs: 'files',
  shellHistory: 'shell',
  editor: 'editor',
};

export function activitySourceLabel(source: unknown) {
  const name = typeof source === 'string' ? source : '';
  return SOURCE_LABELS[name] || name || 'source';
}

export function activityAgeText(ts: unknown, now: number = Date.now()) {
  const stamp = Number(ts);
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  return elapsedText(Number(now) - stamp, COMPACT_FLOORED_AGO);
}

export function activityOverflowText(count: unknown) {
  const total = boundedCount(count);
  if (total <= 0) return '';
  if (total === 1) return '1 more event not shown';
  return `${total} more events not shown`;
}

export function activityCountText(count: unknown) {
  const total = boundedCount(count);
  return total === 1 ? '1 event' : `${total} events`;
}

export function activityScopeText(event: Pick<ActivityEvent, 'root'> | null | undefined) {
  if (!event?.root) return 'machine';
  const root = event.root.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  return lastSeparator === -1 ? root : root.slice(lastSeparator + 1);
}

import { toolDetailLine } from '../../shared/tool-detail.ts';
import { traceRecordsFromTranscriptLine } from './trace-core.ts';

interface TrailToolStep {
  at: number;
  tool: string;
  detail: string;
}

interface TrailNote {
  at: number;
  note: string;
}

type TrailEntry = TrailToolStep | TrailNote;

export interface InvestigationTrail {
  startedAt: number;
  steps: TrailEntry[];
}

const TRAIL_MAX_STEPS = 80;
const TRAIL_TOOL_MAX_CHARS = 64;
const TRAIL_NOTE_MAX_CHARS = 600;

function describeToolStep(toolName: unknown, toolInput: unknown): { tool: string; detail: string } | null {
  const trimmed = typeof toolName === 'string' ? toolName.trim() : '';
  if (!trimmed) return null;
  const tool = trimmed.slice(0, TRAIL_TOOL_MAX_CHARS);
  return { tool, detail: toolDetailLine(tool, toolInput) };
}

export function trailStepFromHook(event: string, payload: Record<string, unknown>): { tool: string; detail: string } | null {
  if (String(event ?? '').toLowerCase() !== 'pretooluse') return null;
  return describeToolStep(payload.tool_name, payload.tool_input);
}

export function trailNotesFromTranscriptLines(lines: readonly string[], now: number): string[] {
  return lines
    .flatMap((line) => traceRecordsFromTranscriptLine(line, { vendorSessionId: '', now }))
    .flatMap((record) => (record.kind === 'assistant' ? [record.text.trim().slice(0, TRAIL_NOTE_MAX_CHARS)] : []))
    .filter((note) => note !== '');
}

export function createInvestigationTrail(startedAt: number): InvestigationTrail {
  return { startedAt, steps: [] };
}

export function appendTrailStep(
  trail: InvestigationTrail,
  step: TrailEntry,
  maxSteps: number = TRAIL_MAX_STEPS,
): InvestigationTrail {
  const isAppendingNote = isTrailNote(step);
  const sameKindEntries = trail.steps.filter((entry) => isTrailNote(entry) === isAppendingNote);
  const evictedCount = Math.max(0, sameKindEntries.length + 1 - maxSteps);
  const evictedEntries = new Set(sameKindEntries.slice(0, evictedCount));
  const keptEntries = trail.steps.filter((entry) => !evictedEntries.has(entry));
  return { startedAt: trail.startedAt, steps: [...keptEntries, step] };
}

function isTrailNote(entry: TrailEntry): entry is TrailNote {
  return 'note' in entry;
}

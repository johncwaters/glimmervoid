import type { DiffAnnotation } from '../../shared/contracts/control-messages.ts';
import {
  DIFF_ANNOTATION_NOTE_MAX_CHARS,
  DIFF_ANNOTATION_PATH_MAX_CHARS,
} from '../../shared/contracts/control-messages.ts';
import { scrubForPaste } from './posthog-core.ts';

const DIFF_ANNOTATION_HEADER = 'Operator review notes on the current worktree diff:';
const DIFF_ANNOTATION_CLOSING = 'Address each note, then reply with what changed.';
const REMOVED_LINE_MARKER = '(removed line)';

export function sortAnnotations(list: readonly DiffAnnotation[]): DiffAnnotation[] {
  return [...list].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    if (left.side === right.side) return 0;
    return left.side < right.side ? -1 : 1;
  });
}

export function formatDiffAnnotationMessage(annotations: readonly DiffAnnotation[]): string {
  const entries = sortAnnotations(annotations).flatMap((annotation) => {
    const note = scrubForPaste(annotation.note, DIFF_ANNOTATION_NOTE_MAX_CHARS);
    const path = scrubForPaste(annotation.path, DIFF_ANNOTATION_PATH_MAX_CHARS);
    if (!note || !path) return [];
    const marker = annotation.side === 'old' ? ` ${REMOVED_LINE_MARKER}` : '';
    return [`- ${path}:${annotation.line} (${annotation.section})${marker} ${note}`];
  });
  if (entries.length === 0) return '';
  return [DIFF_ANNOTATION_HEADER, ...entries, DIFF_ANNOTATION_CLOSING].join('\n');
}

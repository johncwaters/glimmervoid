import type { CoherenceJournalEntry, CoherenceJournalKind, CoherenceNextAction, SessionCoherence } from '#shared/contracts/coherence.ts';
import type { CoherenceHooksState } from '#shared/contracts/session.ts';

const JOURNAL_KIND_LABELS: Record<CoherenceJournalKind, string> = {
  session: 'Session',
  decision: 'Decision',
  blocked: 'Blocked',
  retraction: 'Retraction',
  conjecture: 'Conjecture',
  resolution: 'Resolution',
  dismissal: 'Dismissal',
  defect: 'Defect',
};

const NEXT_ACTION_LABELS: Record<CoherenceNextAction['action'], string> = {
  release: 'Release',
  refuse: 'Refuse',
  'require-decision': 'Require decision',
  redirect: 'Redirect',
};

export function coherenceRowLine(hooks: CoherenceHooksState | null, coherence: SessionCoherence | null): string | null {
  if (hooks?.active === false) return `Coherence hooks not active: ${hooks.reason}`;
  if (!coherence) return null;
  if (coherence.regulation.ok) {
    const nextAction = coherence.regulation.nextAction;
    if (nextAction.action === 'require-decision' || nextAction.action === 'redirect') {
      return [`Coherence: ${nextAction.remedy || nextAction.evidence || NEXT_ACTION_LABELS[nextAction.action]}`, nextAction.command].filter(Boolean).join(' ');
    }
  }
  if (!coherence.journal.ok || !coherence.journal.latest) return null;
  const entry = coherence.journal.latest;
  if (!['decision', 'defect', 'blocked', 'conjecture'].includes(entry.kind)) return null;
  return `${JOURNAL_KIND_LABELS[entry.kind]}: ${entry.text}`;
}

export function formatJournalEntry(entry: CoherenceJournalEntry) {
  return {
    heading: `${JOURNAL_KIND_LABELS[entry.kind]} | ${entry.at} | ${entry.id}`,
    text: entry.text,
    detail: entry.detail,
    supersedes: entry.supersedes ? `Supersedes: ${entry.supersedes}` : null,
  };
}

export function formatCoherenceReading(hooks: CoherenceHooksState | null, coherence: SessionCoherence | null) {
  const lines: string[] = [];
  if (hooks?.active === false) lines.push(`Coherence hooks not active: ${hooks.reason}`);
  if (!coherence) return { lines, command: null };
  if (!coherence.journal.ok) lines.push(`Journal unavailable: ${coherence.journal.reason}`);
  if (!coherence.regulation.ok) {
    lines.push(`Next action unavailable: ${coherence.regulation.reason}`);
    return { lines, command: null };
  }
  const nextAction = coherence.regulation.nextAction;
  lines.push(`Next action: ${NEXT_ACTION_LABELS[nextAction.action]}`);
  if (nextAction.rule) lines.push(`Rule: ${nextAction.rule}`);
  if (nextAction.evidence) lines.push(`Evidence: ${nextAction.evidence}`);
  if (nextAction.remedy) lines.push(`Remedy: ${nextAction.remedy}`);
  lines.push(`Remaining: ${nextAction.remaining}`);
  return { lines, command: nextAction.command };
}

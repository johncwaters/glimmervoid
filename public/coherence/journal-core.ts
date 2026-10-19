import { CoherenceJournalKind, type CoherenceJournalEntry, type SessionCoherence } from '#shared/contracts/coherence.ts';
import { COHERENCE_HOOKS_INACTIVE, type CoherenceHooksState } from '#shared/contracts/session.ts';
import { SIGNAL_TIER } from '../signal-core.ts';
import type { Signal } from '../signal-core.ts';

const JOURNAL_KIND_LABELS: Record<CoherenceJournalKind, string> = {
  decision: 'Decision',
  retraction: 'Retraction',
  conjecture: 'Conjecture',
  resolution: 'Resolution',
  dismissal: 'Dismissal',
  defect: 'Defect',
  experiment: 'Experiment',
  close: 'Close',
  unable: 'Unable',
  escalation: 'Escalation',
  acknowledgement: 'Acknowledgement',
  enactment: 'Enactment',
};

export function coherenceRowSignals(hooks: CoherenceHooksState | null): Signal[] {
  if (hooks?.active !== false || hooks.reason === COHERENCE_HOOKS_INACTIVE.notInstalled) return [];
  return [{ key: 'coherence-hooks', text: 'Hooks off', hoverText: `Coherence hooks not active: ${hooks.reason}${hooks.version ? ` (${hooks.version})` : ''}`, look: { icon: 'failed', tone: 'danger' }, tier: SIGNAL_TIER.broken }];
}

export function formatJournalEntry(entry: CoherenceJournalEntry) {
  const knownKind = CoherenceJournalKind.safeParse(entry.kind);
  return {
    heading: `${knownKind.success ? JOURNAL_KIND_LABELS[knownKind.data] : entry.kind} | ${entry.at ?? 'Unknown time'} | ${entry.id}`,
    text: entry.text,
    detail: entry.detail,
    supersedes: entry.supersedes ? `Supersedes: ${entry.supersedes}` : null,
  };
}

export function formatCoherenceReading(hooks: CoherenceHooksState | null, coherence: SessionCoherence | null) {
  const lines: string[] = [];
  if (hooks?.active === false) lines.push(`Coherence hooks not active: ${hooks.reason}${hooks.version ? ` (${hooks.version})` : ''}`);
  if (coherence && !coherence.journal.ok) lines.push(`Journal unavailable: ${coherence.journal.reason}`);
  return { lines };
}

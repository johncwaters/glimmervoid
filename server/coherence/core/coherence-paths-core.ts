export const COHERENCE_JOURNAL_DIRECTORY = '.coherence';
export const COHERENCE_BOOKKEEPING_PATHSPEC = ['--', '.', `:(exclude)${COHERENCE_JOURNAL_DIRECTORY}`];

export function isCoherenceJournalPath(journalPath: string): boolean {
  const segments = journalPath.split('/');
  return segments.length >= 2 && segments[0] === COHERENCE_JOURNAL_DIRECTORY && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

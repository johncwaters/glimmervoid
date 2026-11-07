const WATCHER_SILENT_INTERVALS = 2;

interface Observation {
  observedAt: string;
}

function isOlderObservation(candidate: Observation, latest: Observation | null): boolean {
  return latest !== null && Date.parse(candidate.observedAt) < Date.parse(latest.observedAt);
}

function watcherFeedError(missingListSentence: string, feedSilenceMs: number, intervalMs: number, sourceService = 'GitHub'): string | null {
  if (feedSilenceMs < WATCHER_SILENT_INTERVALS * intervalMs) return null;
  return `${missingListSentence}: none arrived from glimmervoid watch in the last ${WATCHER_SILENT_INTERVALS} poll intervals. The watcher may be stopped, unable to reach this server's job inbox, or held back by ${sourceService}; its log names the cause.`;
}

export { isOlderObservation, watcherFeedError };
export type { Observation };

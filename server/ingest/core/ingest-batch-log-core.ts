export interface BatchLogState {
  batches: number;
  events: number;
  overflowed: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

export interface BatchLogEntry {
  events: number;
  overflowed: number;
  firstSeq: number;
  lastSeq: number;
}

function emptyBatchLogState(): BatchLogState {
  return { batches: 0, events: 0, overflowed: 0, firstSeq: null, lastSeq: null };
}

function recordBatchLog(state: BatchLogState, entry: BatchLogEntry): BatchLogState {
  const firstSeq = state.firstSeq === null ? entry.firstSeq : Math.min(state.firstSeq, entry.firstSeq);
  const lastSeq = state.lastSeq === null ? entry.lastSeq : Math.max(state.lastSeq, entry.lastSeq);
  return {
    batches: state.batches + 1,
    events: state.events + entry.events,
    overflowed: state.overflowed + entry.overflowed,
    firstSeq,
    lastSeq,
  };
}

function drainBatchLog(state: BatchLogState): { summary: BatchLogState | null; next: BatchLogState } {
  if (state.batches === 0) return { summary: null, next: state };
  return { summary: state, next: emptyBatchLogState() };
}

export { drainBatchLog, emptyBatchLogState, recordBatchLog };

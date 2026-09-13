import test from 'node:test';
import assert from 'node:assert/strict';

import { drainBatchLog, emptyBatchLogState, recordBatchLog } from '../server/core/ingest-batch-log-core.ts';

test('a minute summary rolls up batches and resets for the next minute', () => {
  const first = recordBatchLog(emptyBatchLogState(), { events: 2, overflowed: 0, firstSeq: 3, lastSeq: 4 });
  const second = recordBatchLog(first, { events: 5, overflowed: 2, firstSeq: 5, lastSeq: 11 });
  const drained = drainBatchLog(second);
  assert.deepEqual(drained.summary, { batches: 2, events: 7, overflowed: 2, firstSeq: 3, lastSeq: 11 });
  assert.deepEqual(drainBatchLog(drained.next).summary, null);
});

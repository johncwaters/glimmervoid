import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { headroomFromReadings, parseInactiveFileBytes } from '../server/core/memory-admission-core.ts';

const MEGABYTE = 1024 * 1024;
const SLICE_MEMORY_STAT = ['anon 4000000000', 'file 3191103488', 'active_file 240066560', 'inactive_file 1500000000', 'unevictable 0'].join('\n');

test('cgroup headroom counts reclaimable inactive file cache as free', () => {
  const sliceLevel = { limitBytes: 7945101312, currentBytes: 7945101312 - 549 * MEGABYTE, inactiveFileBytes: parseInactiveFileBytes(SLICE_MEMORY_STAT) };
  const headroomBytes = headroomFromReadings({ cgroupLevels: [sliceLevel], hostAvailableBytes: 6400 * MEGABYTE });
  assert.equal(headroomBytes, 549 * MEGABYTE + 1500000000);
});

test('cgroup headroom without a memory.stat reading keeps limit minus current', () => {
  const sliceLevel = { limitBytes: 1000 * MEGABYTE, currentBytes: 400 * MEGABYTE, inactiveFileBytes: parseInactiveFileBytes(null) };
  assert.equal(headroomFromReadings({ cgroupLevels: [sliceLevel], hostAvailableBytes: null }), 600 * MEGABYTE);
});

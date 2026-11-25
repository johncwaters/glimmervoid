import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { headroomFromReadings, parseInactiveFileBytes, resolveHostResourceProfile, runnerConcurrencyEnv } from '../server/core/memory-admission-core.ts';
import { buildAgentEnv } from '../session/core/spawn-env.ts';

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;
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

test('resolveHostResourceProfile selects compact, standard, and workstation tiers from total host RAM', () => {
  const compact = resolveHostResourceProfile(14 * GIGABYTE);
  assert.equal(compact.tier, 'compact');
  assert.equal(compact.heavyCommandSlots, 1);
  assert.equal(compact.testConcurrency, 2);
  assert.equal(compact.playwrightWorkers, 1);
  assert.equal(compact.threadPoolSize, 4);
  assert.equal(compact.idleHibernateMs, 10 * 60 * 1000);
  assert.equal(compact.headroomFloorBytes, 2 * GIGABYTE);

  const standard = resolveHostResourceProfile(24 * GIGABYTE);
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.heavyCommandSlots, 2);
  assert.equal(standard.testConcurrency, 4);

  const workstation = resolveHostResourceProfile(64 * GIGABYTE);
  assert.equal(workstation.tier, 'workstation');
  assert.equal(workstation.heavyCommandSlots, 4);
  assert.equal(workstation.testConcurrency, null);
  assert.equal(workstation.idleHibernateMs, null);
});

test('buildAgentEnv injects compact runner concurrency caps without overriding caller values', () => {
  const compact = resolveHostResourceProfile(16 * GIGABYTE);
  const env = buildAgentEnv(
    { PATH: '/bin', Playwright_Workers: '3' },
    { gomaxprocs: '8' },
    {},
    { resourceProfile: compact },
  );
  assert.equal(env.Playwright_Workers, '3');
  assert.equal(env.PLAYWRIGHT_WORKERS, undefined);
  assert.equal(env.gomaxprocs, '8');
  assert.equal(env.GOMAXPROCS, undefined);
  assert.equal(env.UV_THREADPOOL_SIZE, '4');
  assert.equal(env.RAYON_NUM_THREADS, '4');
  assert.equal(env.GLIMMERVOID_TEST_CONCURRENCY, '2');

  assert.equal(resolveHostResourceProfile(Number.NaN).tier, 'compact');

  const workstation = resolveHostResourceProfile(64 * GIGABYTE);
  assert.deepEqual(runnerConcurrencyEnv(workstation, {}), {});
});

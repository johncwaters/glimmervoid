import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { anomalyCount, shouldShowHealthMonitor } from '../public/health-monitor-core.ts';

test('the footer shows for debug mode or any current anomaly', () => {
  const clear = { listenerMismatch: false, orphanPty: false, destroyedReachable: false };
  assert.equal(shouldShowHealthMonitor(false, null), false);
  assert.equal(shouldShowHealthMonitor(false, clear), false);
  assert.equal(shouldShowHealthMonitor(true, clear), true);
  assert.equal(shouldShowHealthMonitor(false, { ...clear, listenerMismatch: true }), true);
  assert.equal(shouldShowHealthMonitor(false, { ...clear, orphanPty: true }), true);
  assert.equal(shouldShowHealthMonitor(false, { ...clear, destroyedReachable: true }), true);
  assert.equal(anomalyCount({ ...clear, listenerMismatch: true, orphanPty: true }), 2);
});

test('snapshot and debug updates both recompute footer visibility', () => {
  const source = fs.readFileSync(new URL('../public/health-monitor.ts', import.meta.url), 'utf8');
  assert.match(source, /function setHealthMonitorDebugMode\(on: boolean\) \{\s*_debugModeEnabled = on;\s*updateHealthMonitorVisibility\(\);/);
  assert.match(source, /function applyHealthSnapshot\(stats: HealthSnapshot\) \{\s*_latest = stats;\s*updateHealthMonitorVisibility\(\);\s*if \(!_root \|\| _root\.hidden\) return;/);
});

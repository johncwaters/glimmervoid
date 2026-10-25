import test from 'node:test';
import assert from 'node:assert/strict';

import { KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE, POSITIVE_NUMBER_RANGE, REPLAY_BUFFER_KB_RANGE,
  SETTINGS_RANGES, USAGE_BUDGET_RANGE, USAGE_RETAIN_DAYS_RANGE, USAGE_SCAN_INTERVAL_RANGE, WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE,
} from '../../shared/settings-ranges.ts';
import type { SettingsRange } from '../../shared/settings-ranges.ts';
import { SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import { SETTINGS_INDEX, settingsOf } from '../../shared/settings/registry-core.ts';

test('every editable number setting carries a range the shared catalog owns', () => {
  const catalog: readonly SettingsRange[] = Object.values(SETTINGS_RANGES);
  for (const setting of settingsOf(SETTINGS_REGISTRY.sections)) {
    if (setting.control !== 'number') continue;
    assert.ok(setting.range, `${setting.id} is a number control with no range`);
    assert.ok(catalog.includes(setting.range), `${setting.id} carries a range the shared catalog does not own`);
  }
});

test('the registry hands each number the same range object the schema was built from', () => {
  for (const [id, range] of [
    ['usage-retain-days', USAGE_RETAIN_DAYS_RANGE],
    ['usage-daily-budget', USAGE_BUDGET_RANGE],
    ['usage-monthly-budget', USAGE_BUDGET_RANGE],
    ['file-usage-scan-interval', USAGE_SCAN_INTERVAL_RANGE],
    ['file-replay-buffer', REPLAY_BUFFER_KB_RANGE],
    ['visions-max-per-hour', POSITIVE_NUMBER_RANGE],
    ['team-review-keep-mergeable-timeout', KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE],
    ['workflows-max-concurrent-sessions', WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE],
  ] as const) {
    assert.equal(SETTINGS_INDEX.byId.get(id)?.range, range, id);
  }
});

test('every range in the registry is frozen with a floor at or below its ceiling', () => {
  for (const setting of [...settingsOf(SETTINGS_REGISTRY.sections), ...SETTINGS_REGISTRY.fileOnly]) {
    if (!setting.range) continue;
    assert.ok(Object.isFrozen(setting.range), `${setting.id} range is mutable`);
    if (setting.range.max != null) assert.ok(setting.range.min <= setting.range.max, setting.id);
  }
});

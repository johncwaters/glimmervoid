import test from 'node:test';
import assert from 'node:assert/strict';

import * as ranges from '../shared/settings-ranges.ts';
import type { SettingsRange } from '../shared/settings-ranges.ts';
import {
  BRANCH_GC_NUMERIC_RANGES,
  POSTHOG_NUMERIC_RANGES,
  VISIONS_DISPATCH_NUMERIC_RANGES,
  VISIONS_INTENT_NUMERIC_RANGES,
} from '../server/control-handlers.ts';
import { USAGE_INTEGER_RANGES } from '../server/usage-wiring.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';
import type { SettingsSection } from '../public/settings-map.ts';

test('server resolvers and wire specs reuse the shared range objects', () => {
  assert.strictEqual(USAGE_INTEGER_RANGES, ranges.USAGE_INTEGER_RANGES);
  assert.strictEqual(BRANCH_GC_NUMERIC_RANGES.staleDays, ranges.BRANCH_GC_STALE_DAYS_RANGE);
  assert.strictEqual(VISIONS_DISPATCH_NUMERIC_RANGES.quietMs, ranges.VISIONS_QUIET_MS_RANGE);
  assert.strictEqual(VISIONS_INTENT_NUMERIC_RANGES.threadTtlMs, ranges.VISIONS_INTENT_THREAD_TTL_MS_RANGE);
  assert.strictEqual(POSTHOG_NUMERIC_RANGES.fixTimeoutSeconds, ranges.POSTHOG_FIX_TIMEOUT_RANGE);
});

test('every map number setting names a range the shared catalog carries', () => {
  const catalog: Record<string, SettingsRange | undefined> = ranges.SETTINGS_RANGES;
  const sections: readonly SettingsSection[] = SETTINGS_MAP;
  for (const setting of sections.flatMap((section) => section.settings)) {
    if (setting.control !== 'number') continue;
    const named = setting.range;
    assert.ok(named, `${setting.id} is a number control with no range`);
    assert.ok(catalog[named], `${setting.id} names ${named}, which the shared catalog does not carry`);
  }
});

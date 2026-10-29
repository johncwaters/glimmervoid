export interface SettingsRange {
  min: number;
  max?: number;
  exclusiveMin?: boolean;
  label?: string;
}

export const POSITIVE_NUMBER_RANGE: SettingsRange = Object.freeze({ min: 0, exclusiveMin: true, label: 'a positive number' });
export const NON_NEGATIVE_NUMBER_RANGE: SettingsRange = Object.freeze({ min: 0, label: 'zero or more' });

export const FLYING_ANIMALS_GAP_RANGE = Object.freeze({ min: 0, max: 300 });
export const FLYING_ANIMALS_DURATION_RANGE = Object.freeze({ min: 1, max: 60 });
export const FLYING_ANIMALS_SCALE_RANGE = Object.freeze({ min: 0.5, max: 2 });
export const FLYING_ANIMALS_DEFAULTS = Object.freeze({
  flyingAnimalsMinGapSeconds: 20,
  flyingAnimalsMaxGapSeconds: 40,
  flyingAnimalsMinDurationSeconds: 6.9,
  flyingAnimalsMaxDurationSeconds: 11.5,
  flyingAnimalsScale: 1,
  flyingAnimalsOnPhone: true,
});

export const REPLAY_BUFFER_KB_RANGE = Object.freeze({ min: 64, max: 16384 });
export const MEMORY_RESERVE_MB_RANGE = Object.freeze({ min: 0, max: 65536 });
export const PORT_RANGE = Object.freeze({ min: 0, max: 65535 });
export const TASK_TITLE_TIMEOUT_RANGE = Object.freeze({ min: 0, exclusiveMin: true, max: 2_147_483_647 / 1000 });


export const BRANCH_GC_STALE_DAYS_RANGE = POSITIVE_NUMBER_RANGE;
export const BRANCH_GC_INTERVAL_MS_RANGE = POSITIVE_NUMBER_RANGE;


export const POSTHOG_INTERVAL_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_MAX_CONCURRENT_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_INVESTIGATION_TIMEOUT_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_MIN_USERS_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_ESCALATION_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_RECURRENCE_WINDOW_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_TRANSIENT_RECURRENCE_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_FIX_TIMEOUT_RANGE = Object.freeze({ min: 60, max: 21600, label: 'between 60 and 21600' });
export const POSTHOG_TRAFFIC_MULTIPLIER_RANGE = Object.freeze({ min: 1, label: 'at least 1' });
export const POSTHOG_TRAFFIC_MIN_USERS_RANGE = Object.freeze({ min: 1, label: 'at least 1' });
export const POSTHOG_TRAFFIC_COOLDOWN_RANGE = NON_NEGATIVE_NUMBER_RANGE;
export const POSTHOG_TRAFFIC_BASELINE_RANGE = Object.freeze({ min: 1, max: 30, label: 'between 1 and 30' });

export const USAGE_SCAN_INTERVAL_RANGE = Object.freeze({ min: 1, max: 1440 });
export const USAGE_RETAIN_DAYS_RANGE = Object.freeze({ min: 1, max: 3650 });
const USAGE_WAREHOUSE_RETAIN_DAYS_RANGE = Object.freeze({ min: 30, max: 3650 });
const USAGE_SESSION_BLOCK_HOURS_RANGE = Object.freeze({ min: 1, max: 24 });
export const USAGE_BUDGET_RANGE = POSITIVE_NUMBER_RANGE;
export const USAGE_INTEGER_RANGES = Object.freeze({
  scanIntervalMinutes: USAGE_SCAN_INTERVAL_RANGE,
  retainDays: USAGE_RETAIN_DAYS_RANGE,
  warehouseRetainDays: USAGE_WAREHOUSE_RETAIN_DAYS_RANGE,
  sessionBlockHours: USAGE_SESSION_BLOCK_HOURS_RANGE,
});


export const KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE = Object.freeze({ min: 5, max: 120 });
export const WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE = Object.freeze({ min: 1, max: 5 });
export const WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE = Object.freeze({ min: 1, max: 50 });
export const COMMUNITY_INTERVAL_MINUTES_RANGE = Object.freeze({ min: 1, max: 60 });
export const POSTHOG_PROJECT_ID_RANGE = Object.freeze({ min: 1, max: Number.MAX_SAFE_INTEGER });

export const SETTINGS_RANGES = Object.freeze({
  NON_NEGATIVE_NUMBER_RANGE,
  COMMUNITY_INTERVAL_MINUTES_RANGE,
  FLYING_ANIMALS_GAP_RANGE,
  FLYING_ANIMALS_DURATION_RANGE,
  FLYING_ANIMALS_SCALE_RANGE,
  KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE,
  PORT_RANGE,
  POSTHOG_ESCALATION_RANGE,
  POSTHOG_FIX_TIMEOUT_RANGE,
  POSTHOG_INTERVAL_RANGE,
  POSTHOG_INVESTIGATION_TIMEOUT_RANGE,
  POSTHOG_MAX_CONCURRENT_RANGE,
  POSTHOG_MIN_USERS_RANGE,
  POSTHOG_PROJECT_ID_RANGE,
  POSTHOG_TRAFFIC_BASELINE_RANGE,
  POSTHOG_TRAFFIC_COOLDOWN_RANGE,
  POSTHOG_TRAFFIC_MIN_USERS_RANGE,
  POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  REPLAY_BUFFER_KB_RANGE,
  MEMORY_RESERVE_MB_RANGE,
  TASK_TITLE_TIMEOUT_RANGE,
  USAGE_BUDGET_RANGE,
  USAGE_RETAIN_DAYS_RANGE,
  USAGE_SCAN_INTERVAL_RANGE,
  WORKFLOWS_MAX_ACTIONS_PER_POLL_RANGE,
  WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE,
});

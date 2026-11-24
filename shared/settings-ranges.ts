export interface SettingsRange {
  min: number;
  max?: number;
  exclusiveMin?: boolean;
  label?: string;
}

export const POSITIVE_NUMBER_RANGE: SettingsRange = Object.freeze({ min: 0, exclusiveMin: true, label: 'a positive number' });

export const FLYING_ANIMALS_DEFAULTS = Object.freeze({
  flyingAnimalsMinGapSeconds: 20,
  flyingAnimalsMaxGapSeconds: 40,
  flyingAnimalsMinDurationSeconds: 6.9,
  flyingAnimalsMaxDurationSeconds: 11.5,
  flyingAnimalsScale: 1,
  flyingAnimalsOnPhone: true,
});

export const REVIEWS_TURN_LIMIT_RANGE = Object.freeze({ min: 0, max: 50 });
export const REVIEWS_TURN_LIMIT_DEFAULT = 5;

export const MEMORY_RESERVE_MB_RANGE = Object.freeze({ min: 0, max: 65536 });
export const WORKTREE_DISK_RESERVE_GB_RANGE = Object.freeze({ min: 0, max: 1024 });
export const PACK_SCHEDULED_SESSIONS_RANGE = Object.freeze({ min: 1, max: 20 });
export const PACK_SCHEDULED_SESSIONS_DEFAULT = 3;
export const SPAWNED_SESSIONS_RANGE = Object.freeze({ min: 1, max: 10 });
export const LOOP_GUARD_TURNS_RANGE = Object.freeze({ min: 1, max: 100 });
export const REACTION_COOLDOWN_MINUTES_RANGE = Object.freeze({ min: 1, max: 1440 });
export const LOOP_GUARD_ON_STUCK = Object.freeze(['flag', 'stop'] as const);
export const SPAWNED_SESSIONS_DEFAULT = 3;
export const SKIP_PERMISSIONS_BY_DEFAULT = true;
export const PORT_RANGE = Object.freeze({ min: 0, max: 65535 });


export const POSTHOG_MAX_CONCURRENT_RANGE = POSITIVE_NUMBER_RANGE;
export const POSTHOG_MIN_USERS_RANGE = POSITIVE_NUMBER_RANGE;

export const USAGE_RETAIN_DAYS_RANGE = Object.freeze({ min: 1, max: 3650 });
export const USAGE_BUDGET_RANGE = POSITIVE_NUMBER_RANGE;


export const WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE = Object.freeze({ min: 1, max: 5 });

export const SETTINGS_RANGES = Object.freeze({
  PORT_RANGE,
  POSTHOG_MAX_CONCURRENT_RANGE,
  POSTHOG_MIN_USERS_RANGE,
  REVIEWS_TURN_LIMIT_RANGE,
  MEMORY_RESERVE_MB_RANGE,
  WORKTREE_DISK_RESERVE_GB_RANGE,
  PACK_SCHEDULED_SESSIONS_RANGE,
  SPAWNED_SESSIONS_RANGE,
  LOOP_GUARD_TURNS_RANGE,
  USAGE_BUDGET_RANGE,
  USAGE_RETAIN_DAYS_RANGE,
  WORKFLOWS_MAX_CONCURRENT_SESSIONS_RANGE,
});

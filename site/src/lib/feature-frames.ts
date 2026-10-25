export const BEAT_MS = 800;
export const BOOT_STEP_HOLD_MS: readonly number[] = [5, 1, 1, 1].map((beats) => beats * BEAT_MS);
export const HELPER_HOLD_MS: readonly number[] = [4, 2, 2, 2, 2, 3].map((beats) => beats * BEAT_MS);
export const REVIEW_HOLD_MS: readonly number[] = [4, 2, 2, 3].map((beats) => beats * BEAT_MS);

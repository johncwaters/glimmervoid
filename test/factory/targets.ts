export const targets = {
  throwaway: { workLimitMinutes: 30, defaultIntent: 'one-file-change' },
  'gated-clone': { workLimitMinutes: 90, defaultIntent: 'gated-one-file-change' },
} as const;

export type TargetName = keyof typeof targets;

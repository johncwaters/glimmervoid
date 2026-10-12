export const targets: Record<'throwaway' | 'gated-clone', { workLimitMinutes: number | null; defaultIntent: string }> = {
  throwaway: { workLimitMinutes: 30, defaultIntent: 'one-file-change' },
  'gated-clone': { workLimitMinutes: null, defaultIntent: 'gated-one-file-change' },
};

export type TargetName = keyof typeof targets;

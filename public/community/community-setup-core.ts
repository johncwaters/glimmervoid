type SetupStepState = 'done' | 'current' | 'upcoming';

const COMMUNITY_SETUP_STEPS = ['key', 'readToken', 'project', 'skill', 'discord'] as const;

type CommunitySetupStep = typeof COMMUNITY_SETUP_STEPS[number];

type CommunitySetupProgress = CommunitySetupStep | 'finished';

function communitySetupStepStates(progress: CommunitySetupProgress): Record<CommunitySetupStep, SetupStepState> {
  const currentIndex = progress === 'finished' ? COMMUNITY_SETUP_STEPS.length : COMMUNITY_SETUP_STEPS.indexOf(progress);
  const stateAt = (index: number): SetupStepState => (index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming');
  return { key: stateAt(0), readToken: stateAt(1), project: stateAt(2), skill: stateAt(3), discord: stateAt(4) };
}

function discordChannelsFromText(typedText: string): string[] {
  const channels = typedText.split(/[\s,]+/).map((channel) => channel.replace(/^#/, '')).filter(Boolean);
  return [...new Set(channels)];
}

export { communitySetupStepStates, discordChannelsFromText };
export type { CommunitySetupProgress };

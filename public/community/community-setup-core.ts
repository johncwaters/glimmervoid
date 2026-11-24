type SetupStepState = 'done' | 'current' | 'upcoming';

const COMMUNITY_SETUP_STEPS = ['readToken', 'skill'] as const;

type CommunitySetupStep = typeof COMMUNITY_SETUP_STEPS[number];

type CommunitySetupProgress = CommunitySetupStep | 'finished';

function communitySetupStepStates(progress: CommunitySetupProgress): Record<CommunitySetupStep, SetupStepState> {
  const currentIndex = progress === 'finished' ? COMMUNITY_SETUP_STEPS.length : COMMUNITY_SETUP_STEPS.indexOf(progress);
  const stateAt = (index: number): SetupStepState => (index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming');
  return { readToken: stateAt(0), skill: stateAt(1) };
}

export { communitySetupStepStates };
export type { CommunitySetupProgress };

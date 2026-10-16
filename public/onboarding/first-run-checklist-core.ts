import { decideAgentAvailability, decideAgentPicker } from '../session-card/agent-core.ts';

type FirstRunStepState = 'done' | 'current' | 'upcoming';

type FirstRunSteps = { agent: FirstRunStepState; repoRoots: FirstRunStepState; firstSession: FirstRunStepState };

const UPCOMING_STEPS: FirstRunSteps = { agent: 'upcoming', repoRoots: 'upcoming', firstSession: 'upcoming' };

function stepStateFor(stepNumber: number, currentStepNumber: number): FirstRunStepState {
  if (stepNumber < currentStepNumber) return 'done';
  if (stepNumber === currentStepNumber) return 'current';
  return 'upcoming';
}

function decideFirstRunSteps({ agentListing, repoRoots }: { agentListing: unknown; repoRoots: readonly string[] }): FirstRunSteps {
  const hasAgent = decideAgentAvailability(agentListing).canSpawn;
  const currentStepNumber = !hasAgent ? 1 : repoRoots.length === 0 ? 2 : 3;
  return {
    agent: stepStateFor(1, currentStepNumber),
    repoRoots: stepStateFor(2, currentStepNumber),
    firstSession: stepStateFor(3, currentStepNumber),
  };
}

function agentSummaryText(agentListing: unknown): string {
  const agents = typeof agentListing === 'object' && agentListing !== null ? (agentListing as { agents?: unknown }).agents : [];
  return decideAgentPicker(agents).options.map((agentOption) => agentOption.label).join(', ');
}

function gitRepoCountText(gitRepoCount: number): string {
  return gitRepoCount === 1 ? '1 git repo' : `${gitRepoCount} git repos`;
}

function withRepoRootAdded(repoRoots: readonly string[], addedRoot: string): string[] | null {
  const trimmedRoot = addedRoot.trim();
  if (!trimmedRoot || repoRoots.includes(trimmedRoot)) return null;
  return [...repoRoots, trimmedRoot];
}

export { decideFirstRunSteps, agentSummaryText, gitRepoCountText, withRepoRootAdded, UPCOMING_STEPS };
export type { FirstRunStepState, FirstRunSteps };

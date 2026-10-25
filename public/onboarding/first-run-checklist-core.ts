import type { OnboardingStepReport } from '#shared/contracts/control-messages.ts';
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

const REPORTED_STEP_BY_CHECKLIST_STEP = [
  ['agent', 'agent'],
  ['repoRoots', 'repo_roots'],
  ['firstSession', 'first_session'],
] as const;

function onboardingStepReportKey({ step, state }: OnboardingStepReport): string {
  return `${step}:${state}`;
}

function decideOnboardingStepReports(reportedStepKeys: ReadonlySet<string>, steps: FirstRunSteps): OnboardingStepReport[] {
  const reports: OnboardingStepReport[] = [];
  for (const [checklistStep, reportedStep] of REPORTED_STEP_BY_CHECKLIST_STEP) {
    const state = steps[checklistStep];
    if (state === 'upcoming') continue;
    const report = { step: reportedStep, state };
    if (!reportedStepKeys.has(onboardingStepReportKey(report))) reports.push(report);
  }
  return reports;
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

export { decideFirstRunSteps, decideOnboardingStepReports, onboardingStepReportKey, agentSummaryText, gitRepoCountText, withRepoRootAdded, UPCOMING_STEPS };
export type { FirstRunStepState, FirstRunSteps };

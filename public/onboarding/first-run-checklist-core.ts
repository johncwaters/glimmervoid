import type { OnboardingStepReport } from '#shared/contracts/control-messages.ts';
import { SHELL_AGENT_ID, decideAgentAvailability, decideAgentPicker } from '../session-card/agent-core.ts';

type FirstRunStepState = 'done' | 'current' | 'upcoming';

type FirstRunSteps = { agent: FirstRunStepState; repoRoots: FirstRunStepState; firstSession: FirstRunStepState };

const UPCOMING_STEPS: FirstRunSteps = { agent: 'upcoming', repoRoots: 'upcoming', firstSession: 'upcoming' };

function stepStateFor(stepNumber: number, currentStepNumber: number): FirstRunStepState {
  if (stepNumber < currentStepNumber) return 'done';
  if (stepNumber === currentStepNumber) return 'current';
  return 'upcoming';
}

function isShellAgent(agent: unknown): boolean {
  return (agent as { id?: unknown } | null)?.id === SHELL_AGENT_ID;
}

function listedAgents(agentListing: unknown): unknown[] {
  if (typeof agentListing !== 'object' || agentListing === null) return [];
  const agents = (agentListing as { agents?: unknown }).agents;
  return Array.isArray(agents) ? agents : [];
}

function withoutShell(agentListing: unknown): unknown {
  if (typeof agentListing !== 'object' || agentListing === null) return agentListing;
  const reply = agentListing as { agents?: unknown };
  if (!Array.isArray(reply.agents)) return agentListing;
  return { ...reply, agents: listedAgents(reply).filter((agent) => !isShellAgent(agent)) };
}

function decideFirstRunSteps({ agentListing, repoRoots }: { agentListing: unknown; repoRoots: readonly string[] }): FirstRunSteps {
  const hasAgent = decideAgentAvailability(withoutShell(agentListing)).canSpawn;
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
  const agents = listedAgents(agentListing).filter((agent) => !isShellAgent(agent));
  return decideAgentPicker(agents).options.map((agentOption) => agentOption.label).join(', ');
}

const agentChoiceJoiner = new Intl.ListFormat('en-GB', { style: 'long', type: 'disjunction' });

function installableAgentsText(agentListing: unknown): string {
  const labels = listedAgents(agentListing)
    .filter((agent) => !isShellAgent(agent) && (agent as { hidden?: unknown } | null)?.hidden !== true)
    .map((agent) => (agent as { label?: unknown } | null)?.label)
    .filter((label): label is string => typeof label === 'string' && label.length > 0);
  if (labels.length === 0) return 'an agent CLI';
  return agentChoiceJoiner.format(labels);
}

function canOpenShell(agentListing: unknown): boolean {
  return decideAgentPicker(listedAgents(agentListing), { defaultId: SHELL_AGENT_ID }).options.some((agentOption) => agentOption.id === SHELL_AGENT_ID);
}

function gitRepoCountText(gitRepoCount: number): string {
  return gitRepoCount === 1 ? '1 git repo' : `${gitRepoCount} git repos`;
}

function withRepoRootsAdded(repoRoots: readonly string[], addedRoots: readonly string[]): string[] | null {
  const nextRoots = [...repoRoots];
  for (const addedRoot of addedRoots) {
    const trimmedRoot = addedRoot.trim();
    if (trimmedRoot && !nextRoots.includes(trimmedRoot)) nextRoots.push(trimmedRoot);
  }
  return nextRoots.length === repoRoots.length ? null : nextRoots;
}

function rootsToAutoSave(configuredRoots: readonly string[], suggestions: readonly { path: string; gitRepoCount: number }[]): string[] {
  if (configuredRoots.length > 0) return [];
  return suggestions.filter((suggestion) => suggestion.gitRepoCount > 0).map((suggestion) => suggestion.path);
}


const FIRST_TASK_PROMPT = 'Get to know this repo, then draw its architecture on a Glimmervoid board: the main modules, how they connect, and where a typical change starts. Keep it to one screen.';

type StartProject = { name: string; path: string };

type ScannedDirectory = { projects: readonly { name: string; path: string }[] };

function startProjects(directories: readonly ScannedDirectory[]): StartProject[] {
  return directories.flatMap((directory) => directory.projects.map(({ name, path }) => ({ name, path })));
}

function decideStartAgents(agentListing: unknown) {
  return decideAgentPicker(listedAgents(agentListing).filter((agent) => !isShellAgent(agent)));
}

function decideVisibleProjects(projects: readonly StartProject[], filterText: string, selectedPath: string | null) {
  const needle = filterText.trim().toLowerCase();
  const visibleProjects = needle ? projects.filter((project) => project.name.toLowerCase().includes(needle)) : [...projects];
  const isSelectionVisible = visibleProjects.some((project) => project.path === selectedPath);
  return { visibleProjects, selectedPath: isSelectionVisible ? selectedPath : visibleProjects[0]?.path ?? null };
}

export { FIRST_TASK_PROMPT, startProjects, decideStartAgents, decideVisibleProjects, canOpenShell, installableAgentsText, decideFirstRunSteps, decideOnboardingStepReports, onboardingStepReportKey, agentSummaryText, gitRepoCountText, rootsToAutoSave, withRepoRootsAdded, UPCOMING_STEPS };
export type { FirstRunSteps, StartProject };

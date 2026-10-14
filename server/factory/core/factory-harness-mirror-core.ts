import path from 'node:path';
import { FactoryHarnessStateLine } from '../../../shared/contracts/factory.ts';
import type { FactoryHarnessVerdict, FactoryProjectState, FactoryState } from '../../../shared/contracts/factory.ts';

export const HARNESS_MIRROR_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const HARNESS_MIRROR_PROJECT_PREFIX = 'harness-';
const BATCH_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
const RUN_NAME_PATTERN = /^\d{4}$/;
export const HARNESS_STATE_FILE_NAME = 'factory-state.jsonl';
export const HARNESS_VERDICT_FILE_NAME = 'verdict.json';

export function factoryHarnessRunsDirectory(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
  return path.join(environment.XDG_STATE_HOME || path.join(homeDirectory, '.local/state'), 'glimmervoid-factory-runs');
}

export function harnessBatchName(startedAt: Date, uniqueId: string): string {
  return `${startedAt.toISOString().replace(/[:.]/g, '-')}-${uniqueId.slice(0, 8)}`;
}

export function harnessRunName(run: number): string {
  return String(run).padStart(4, '0');
}

function latestMatchingName(names: readonly string[], pattern: RegExp): string | null {
  return names.filter((name) => pattern.test(name)).sort().at(-1) ?? null;
}

export function latestHarnessBatchName(names: readonly string[]): string | null {
  return latestMatchingName(names, BATCH_NAME_PATTERN);
}

export function latestHarnessRunName(names: readonly string[]): string | null {
  return latestMatchingName(names, RUN_NAME_PATTERN);
}

function parseStateLine(line: string): FactoryState | null {
  try { return FactoryHarnessStateLine.safeParse(JSON.parse(line)).data?.state ?? null; }
  catch { return null; }
}

export function latestHarnessState(tail: string, isCutAtStart: boolean): FactoryState | null {
  const lines = tail.split('\n').slice(isCutAtStart ? 1 : 0).filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const state = parseStateLine(lines[index]);
    if (state) return state;
  }
  return null;
}

export function isHarnessRunFresh(lastWriteMs: number, nowMs: number): boolean {
  return nowMs - lastWriteMs <= HARNESS_MIRROR_MAX_IDLE_MS;
}

export function describeHarnessOutcome(verdict: FactoryHarnessVerdict | null): string | null {
  if (!verdict) return null;
  return verdict.failureClass ? `${verdict.outcome} (${verdict.failureClass})` : verdict.outcome;
}

export function mirrorHarnessProjects(state: FactoryState, observedRun: NonNullable<FactoryProjectState['observedRun']>): FactoryProjectState[] {
  return state.projects.map((project) => ({
    ...project, projectId: `${HARNESS_MIRROR_PROJECT_PREFIX}${project.projectId}`, projectName: `Harness run: ${project.projectName}`, observedRun,
  }));
}

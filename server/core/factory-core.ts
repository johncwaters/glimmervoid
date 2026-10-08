import type { Config } from '../../shared/contracts/config.ts';
import type { CoherenceOrient, CoherenceWorkInspect } from '../../shared/contracts/coherence.ts';
import { FactoryProjectState } from '../../shared/contracts/factory.ts';

export const FACTORY_TICK_INTERVAL_MS = 10_000;
export const FACTORY_FIRST_TICK_DELAY_MS = 2_000;

export function factoryShouldStart(config: Pick<Config, 'factory'>): { start: boolean; reason?: string } {
  return { start: config.factory?.enabled === true };
}

export function buildFactoryProjectState({ projectId, projectName, headSha, orient, work, error }: {
  projectId: string;
  projectName: string;
  headSha: string | null;
  orient: CoherenceOrient | null;
  work: CoherenceWorkInspect | null;
  error: string | null;
}): FactoryProjectState {
  if (error === null && orient?.action === 'refuse') {
    return {
      projectId, projectName, headSha, error: null,
      heading: { action: 'refuse', reasons: orient.reasons },
      orders: [], conflicts: [], unverifiedCompletedWork: orient.consequences.unverifiedCompletedWork,
    };
  }
  if (error !== null || orient === null || work === null) {
    const failure = error ?? 'Coherence orientation or work inspection is unavailable';
    return {
      projectId, projectName, headSha, error: failure,
      heading: { action: 'refuse', reasons: [failure] },
      orders: [], conflicts: [], unverifiedCompletedWork: [],
    };
  }
  return {
    projectId, projectName, headSha, error: null,
    heading: { action: orient.action, reasons: orient.reasons },
    orders: work.work.map((order) => ({
      id: order.work,
      objective: order.opened.objective,
      criteria: order.opened.criteria,
      risk: order.opened.risk,
      state: order.state,
      readiness: order.readiness,
      parent: order.opened.parent,
      dependsOn: order.opened.dependsOn,
      writeScopes: order.opened.writeScopes,
      owner: order.owner.session || null,
      lastEvent: order.last === null ? null : { event: order.last.event, at: order.last.at, session: order.last.session },
    })),
    conflicts: (orient.work?.conflicts ?? []).map(({ left, right, scope }) => ({ left, right, scope })),
    unverifiedCompletedWork: orient.consequences.unverifiedCompletedWork,
  };
}

export function factoryStateSignature(projects: FactoryProjectState[]): string {
  return JSON.stringify(projects.map((project) => FactoryProjectState.parse(project))
    .sort((left, right) => left.projectId.localeCompare(right.projectId)));
}

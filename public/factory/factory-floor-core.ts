import type { FactoryProjectState } from '#shared/contracts/factory.ts';
import { BADGE_LABELS, STATES } from '#shared/states.ts';
import type { SessionState } from '#shared/states.ts';
import { ANIMALS } from '../nyan-animals-core.ts';

type FactoryOrder = FactoryProjectState['orders'][number];
export type FactoryStation = 'queue' | 'workers' | 'review' | 'shipped';

export interface FactoryCrate {
  id: string;
  objective: string;
  sessionId: string | null;
  risk: FactoryOrder['risk'];
  station: FactoryStation;
  status: string;
  hasConflict: boolean;
  isHeld: boolean;
  isSelected: boolean;
  animal: (typeof ANIMALS)[number];
}

export interface FactoryFloor {
  paused: boolean;
  spend: string;
  note: string | null;
  digests: FactoryIntentDigest[];
  intent: { id: string; objective: string; criteria: { text: string; isMet: boolean }[]; shippedCount: number; childCount: number } | null;
  upNext: { id: string; objective: string }[];
  orchestrator: { action: string; reason: string; isException: boolean; sessionId: string | null; stateLabel: string | null };
  stations: Record<FactoryStation, FactoryCrate[]>;
  ledger: { orderId: string; event: string; at: string; session: string }[];
  selectedOrder: { id: string; intent: string | null; writeScopes: string[]; dependsOn: string[]; station: string; owner: string | null } | null;
}

interface FactoryIntentDigest {
  intentId: string;
  objective: string;
  merged: { id: string; objective: string }[];
  parked: { id: string; objective: string; need: string | null }[];
  confirmedFlakes: string[];
  isPartial: boolean;
}

export function buildFactoryIntentDigests(state: FactoryProjectState): FactoryIntentDigest[] {
  const partialIntentIds = new Set(state.partialIntentIds ?? []);
  const digestsByIntentId = new Map<string, FactoryIntentDigest>();
  for (const order of state.orders) {
    if (order.parent !== null) continue;
    const isPartial = partialIntentIds.has(order.id);
    if (!isPartial && order.state !== 'completed') continue;
    digestsByIntentId.set(order.id, {
      intentId: order.id, objective: order.objective, merged: [], parked: [],
      confirmedFlakes: state.confirmedFlakesByIntent?.[order.id] ?? [], isPartial,
    });
  }
  for (const order of state.orders) {
    if (order.parent === null) continue;
    const digest = digestsByIntentId.get(order.parent);
    if (!digest) continue;
    if (order.state === 'completed') digest.merged.push({ id: order.id, objective: order.objective });
    if (order.parked) digest.parked.push({ id: order.id, objective: order.objective, need: order.blockReason ?? null });
  }
  return [...digestsByIntentId.values()];
}

function pickStation(order: FactoryOrder, unverifiedIds: Set<string>, reviewingIds: Set<string>): FactoryStation | null {
  if (reviewingIds.has(order.id)) return 'review';
  if (order.state === 'open' || order.state === 'blocked') return 'queue';
  if (order.state === 'active') return 'workers';
  if (order.state !== 'completed') return null;
  return unverifiedIds.has(order.id) ? 'review' : 'shipped';
}

function pickAnimal(order: FactoryOrder): (typeof ANIMALS)[number] {
  let identityHash = 0;
  for (const character of order.owner ?? order.id) identityHash = (Math.imul(identityHash, 31) + character.charCodeAt(0)) >>> 0;
  return ANIMALS[identityHash % ANIMALS.length];
}

function orderStatus(order: FactoryOrder, hasConflict: boolean, station: FactoryStation): string {
  if (order.parked) return 'Parked';
  if (hasConflict) return 'Scope conflict';
  if (order.state === 'blocked') return 'Blocked';
  if (order.state === 'open' && order.readiness === 'waiting') return 'Waiting on dependency';
  if (station === 'workers') return 'Running';
  if (station === 'review') return 'Unverified';
  if (station === 'shipped') return 'Shipped';
  return 'Ready';
}

function describeOrchestratorState(orchestratorState: SessionState | null, liveWorkerCount: number): string | null {
  if (orchestratorState === null) return null;
  if (orchestratorState === STATES.RUNNING) return 'Planning';
  if (orchestratorState !== STATES.IDLE && orchestratorState !== STATES.COMPLETE) return BADGE_LABELS[orchestratorState];
  return liveWorkerCount > 0 ? 'Waiting on workers' : 'Idle';
}

function findIntent(order: FactoryOrder, ordersById: Map<string, FactoryOrder>): FactoryOrder | null {
  const visitedIds = new Set<string>();
  let ancestor: FactoryOrder | undefined = order;
  while (ancestor) {
    if (visitedIds.has(ancestor.id)) return null;
    visitedIds.add(ancestor.id);
    if (ancestor.parent === null) return ancestor;
    ancestor = ordersById.get(ancestor.parent);
  }
  return null;
}

export function buildFactoryFloor(state: FactoryProjectState, selectedOrderId: string | null): FactoryFloor {
  const openRoots = state.orders.filter((order) => order.parent === null && order.state !== 'completed' && order.state !== 'cancelled')
    .sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  const activeParentIds = new Set(state.orders.filter((order) => order.state === 'active').map((order) => order.parent));
  const activeIntent = openRoots.find((root) => root.id === state.orchestrator?.intentId) ?? openRoots.find((root) => activeParentIds.has(root.id)) ?? openRoots[0] ?? null;
  const children = activeIntent ? state.orders.filter((order) => order.parent === activeIntent.id) : [];
  const reviewingIds = new Set(state.reviewing ?? []);
  const unverifiedIds = new Set(state.unverifiedCompletedWork);
  const conflictIds = new Set(state.conflicts.flatMap((conflict) => [conflict.left, conflict.right]));
  const workerSessionIds = new Map(state.liveWorkers?.map((worker) => [worker.workId, worker.sessionId]));
  const stations: FactoryFloor['stations'] = { queue: [], workers: [], review: [], shipped: [] };
  const floorOrders = state.orders.filter((order) => order.parent === activeIntent?.id);
  for (const order of floorOrders) {
    const station = pickStation(order, unverifiedIds, reviewingIds);
    if (!station) continue;
    const hasConflict = conflictIds.has(order.id);
    const isHeld = hasConflict || order.state === 'blocked' || (order.state === 'open' && order.readiness === 'waiting');
    stations[station].push({
      id: order.id, objective: order.objective, sessionId: workerSessionIds.get(order.id) ?? null, risk: order.risk, station,
      status: reviewingIds.has(order.id) ? 'Reviewing' : orderStatus(order, hasConflict, station), hasConflict, isHeld,
      isSelected: order.id === selectedOrderId, animal: pickAnimal(order),
    });
  }
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  const selectedOrder = selectedOrderId === null ? undefined : ordersById.get(selectedOrderId);
  const selectedIntent = selectedOrder ? findIntent(selectedOrder, ordersById) : null;
  const orchestratorStateLabel = describeOrchestratorState(state.orchestrator?.state ?? null, state.liveWorkers?.length ?? 0);
  return {
    paused: state.paused,
    spend: `Factory today: $${(state.spentTodayUsd ?? 0).toFixed(2)} / ${state.dailyBudgetUsd == null ? 'unlimited' : `$${state.dailyBudgetUsd.toFixed(2)}`}`,
    note: state.note ?? null,
    digests: buildFactoryIntentDigests(state),
    intent: activeIntent ? {
      id: activeIntent.id, objective: activeIntent.objective,
      criteria: activeIntent.criteria.map((text) => ({ text, isMet: activeIntent.state === 'completed' })),
      shippedCount: stations.shipped.length, childCount: children.length,
    } : null,
    upNext: openRoots.filter((root) => root.id !== activeIntent?.id).map(({ id, objective }) => ({ id, objective })),
    orchestrator: state.error === null
      ? { action: state.heading.action, reason: state.heading.reasons[0] ?? '', isException: false, sessionId: state.orchestrator?.sessionId ?? null, stateLabel: orchestratorStateLabel }
      : { action: 'Exception', reason: state.error, isException: true, sessionId: state.orchestrator?.sessionId ?? null, stateLabel: orchestratorStateLabel },
    stations,
    ledger: state.orders.flatMap((order) => order.lastEvent ? [{ orderId: order.id, ...order.lastEvent }] : [])
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 50),
    selectedOrder: selectedOrder ? {
      id: selectedOrder.id, intent: selectedIntent?.objective ?? null,
      writeScopes: selectedOrder.writeScopes, dependsOn: selectedOrder.dependsOn,
      station: selectedOrder.parent === null ? 'intent' : pickStation(selectedOrder, unverifiedIds, reviewingIds) ?? 'cancelled',
      owner: selectedOrder.owner,
    } : null,
  };
}

export function pickFactoryProject(projects: FactoryProjectState[], selectedProjectId: string | null): FactoryProjectState | null {
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
  if (selectedProject) return selectedProject;
  return [...projects].sort((left, right) => left.projectName.localeCompare(right.projectName) || left.projectId.localeCompare(right.projectId))[0] ?? null;
}

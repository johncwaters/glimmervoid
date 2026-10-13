import type { FactoryProjectState } from '#shared/contracts/factory.ts';
import type { SessionState } from '#shared/states.ts';
import { ANIMALS } from '../nyan-animals.ts';

type FactoryOrder = FactoryProjectState['orders'][number];
export type FactoryStation = 'queue' | 'workers' | 'review' | 'watch' | 'shipped';

export interface FactoryCrate {
  id: string;
  title: string;
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
  intent: { id: string; objective: string; criteria: { text: string; isMet: boolean }[]; shippedCount: number; childCount: number } | null;
  upNext: { id: string; title: string; objective: string }[];
  orchestrator: { action: string; reason: string; isException: boolean; sessionId: string | null; state: SessionState | null };
  stations: Record<FactoryStation, FactoryCrate[]>;
  ledger: { orderId: string; title: string; description: string; at: string }[];
  selectedOrder: {
    id: string; title: string; objective: string; status: string; intent: string | null;
    writeScopes: string[]; dependsOn: string[]; station: string; owner: string | null;
  } | null;
}

const TICKET_TITLE_MAX_CHARS = 90;
const FIRST_SENTENCE_PATTERN = /^.+?[.!?](?=\s|$)/s;
const TRANSITION_DESCRIPTIONS: Record<FactoryOrder['state'], string> = {
  open: 'reopened', active: 'started', blocked: 'blocked', completed: 'completed', cancelled: 'cancelled',
};

export function ticketTitle(objective: string): string {
  const firstSentence = FIRST_SENTENCE_PATTERN.exec(objective)?.[0] ?? objective;
  if (firstSentence.length <= TICKET_TITLE_MAX_CHARS) return firstSentence;
  const clipped = firstSentence.slice(0, TICKET_TITLE_MAX_CHARS);
  const lastWordBreak = clipped.lastIndexOf(' ');
  return `${lastWordBreak > 0 ? clipped.slice(0, lastWordBreak) : clipped}...`;
}

function nameTickets(text: string, ordersById: Map<string, FactoryOrder>): string {
  let named = text;
  for (const [id, order] of ordersById) named = named.replaceAll(id, `"${ticketTitle(order.objective)}"`);
  return named;
}

function describeLedgerEvent(order: FactoryOrder, event: string): string {
  if (event === 'transitioned') return TRANSITION_DESCRIPTIONS[order.state];
  return event;
}

function pickStation(order: FactoryOrder, unverifiedIds: Set<string>, reviewingIds: Set<string>, watchIds: Set<string>): FactoryStation | null {
  if (watchIds.has(order.id)) return 'watch';
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
  if (hasConflict) return 'Scope conflict';
  if (order.state === 'blocked') return 'Blocked';
  if (order.state === 'open' && order.readiness === 'waiting') return 'Waiting on dependency';
  if (station === 'workers') return 'Running';
  if (station === 'review') return 'Unverified';
  if (station === 'watch') return 'Watching';
  if (station === 'shipped') return 'Shipped';
  return 'Ready';
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
  const watchIds = new Set((state.watches ?? []).map((watch) => watch.workId));
  const reviewingIds = new Set(state.reviewing ?? []);
  const unverifiedIds = new Set(state.unverifiedCompletedWork);
  const conflictIds = new Set(state.conflicts.flatMap((conflict) => [conflict.left, conflict.right]));
  const stations: FactoryFloor['stations'] = { queue: [], workers: [], review: [], watch: [], shipped: [] };
  const floorOrders = state.orders.filter((order) => order.parent === activeIntent?.id || watchIds.has(order.id));
  for (const order of floorOrders) {
    const station = pickStation(order, unverifiedIds, reviewingIds, watchIds);
    if (!station) continue;
    const hasConflict = conflictIds.has(order.id);
    const isHeld = hasConflict || order.state === 'blocked' || (order.state === 'open' && order.readiness === 'waiting');
    stations[station].push({
      id: order.id, title: ticketTitle(order.objective), objective: order.objective, sessionId: state.liveWorkers?.find((worker) => worker.workId === order.id)?.sessionId ?? null, risk: order.risk, station,
      status: reviewingIds.has(order.id) ? 'Reviewing' : orderStatus(order, hasConflict, station), hasConflict, isHeld,
      isSelected: false, animal: pickAnimal(order),
    });
  }
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  const crates = [...stations.workers, ...stations.review, ...stations.queue, ...stations.watch, ...stations.shipped];
  const effectiveSelectedId = (selectedOrderId !== null && ordersById.has(selectedOrderId) ? selectedOrderId : null) ?? crates[0]?.id ?? activeIntent?.id ?? null;
  for (const crate of crates) crate.isSelected = crate.id === effectiveSelectedId;
  const selectedOrder = effectiveSelectedId === null ? undefined : ordersById.get(effectiveSelectedId);
  const selectedIntent = selectedOrder ? findIntent(selectedOrder, ordersById) : null;
  const selectedCrate = crates.find((crate) => crate.id === effectiveSelectedId);
  return {
    paused: state.paused,
    spend: `Factory today: $${(state.spentTodayUsd ?? 0).toFixed(2)} / ${state.dailyBudgetUsd == null ? 'unlimited' : `$${state.dailyBudgetUsd.toFixed(2)}`}`,
    note: state.note ?? null,
    intent: activeIntent ? {
      id: activeIntent.id, objective: activeIntent.objective,
      criteria: activeIntent.criteria.map((text) => ({ text, isMet: activeIntent.state === 'completed' })),
      shippedCount: stations.shipped.length, childCount: children.length,
    } : null,
    upNext: openRoots.filter((root) => root.id !== activeIntent?.id).map(({ id, objective }) => ({ id, title: ticketTitle(objective), objective })),
    orchestrator: state.error === null
      ? { action: state.heading.action, reason: nameTickets(state.heading.reasons[0] ?? '', ordersById), isException: false, sessionId: state.orchestrator?.sessionId ?? null, state: state.orchestrator?.state ?? null }
      : { action: 'Exception', reason: state.error, isException: true, sessionId: state.orchestrator?.sessionId ?? null, state: state.orchestrator?.state ?? null },
    stations,
    ledger: state.orders.flatMap((order) => order.lastEvent
      ? [{ orderId: order.id, title: ticketTitle(order.objective), description: describeLedgerEvent(order, order.lastEvent.event), at: order.lastEvent.at }]
      : [])
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 50),
    selectedOrder: selectedOrder ? {
      id: selectedOrder.id, title: ticketTitle(selectedOrder.objective), objective: selectedOrder.objective,
      status: selectedOrder.parent === null ? 'Intent' : selectedCrate?.status ?? TRANSITION_DESCRIPTIONS[selectedOrder.state],
      intent: selectedIntent?.objective ?? null, writeScopes: selectedOrder.writeScopes,
      dependsOn: selectedOrder.dependsOn.map((id) => { const dependency = ordersById.get(id); return dependency ? ticketTitle(dependency.objective) : id; }),
      station: selectedOrder.parent === null ? 'intent' : pickStation(selectedOrder, unverifiedIds, reviewingIds, watchIds) ?? 'cancelled',
      owner: selectedOrder.owner,
    } : null,
  };
}

export function pickFactoryProject(projects: FactoryProjectState[], selectedProjectId: string | null): FactoryProjectState | null {
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
  if (selectedProject) return selectedProject;
  return [...projects].sort((left, right) => left.projectName.localeCompare(right.projectName) || left.projectId.localeCompare(right.projectId))[0] ?? null;
}

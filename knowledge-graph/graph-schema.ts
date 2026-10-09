import { z } from 'zod';

type KindDefinition = {
  idPrefix: string;
  description: string;
  properties: z.ZodType<Record<string, unknown>>;
};

type EdgeDefinition = {
  description: string;
  fromKinds: readonly string[] | 'any';
  toKinds: readonly string[] | 'any';
  maxOutgoingPerNode?: number;
  isAcyclic?: boolean;
};

export type GraphSchema = {
  name: string;
  version: number;
  kinds: Record<string, KindDefinition>;
  edges: Record<string, EdgeDefinition>;
};

export type GraphNode = {
  id: string;
  kind: string;
  title: string;
  body: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GraphEdge = {
  edgeType: string;
  fromId: string;
  toId: string;
  createdAt: string;
};

type EdgeCandidate = {
  edgeType: string;
  fromId: string;
  fromKind: string;
  toId: string;
  toKind: string;
  existingOutgoingCount: number;
  targetReachesSource: boolean;
};

const UNSAFE_TEXT_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

const INVISIBLE_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/gu;

export function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE_TEXT_CHARACTERS, '') !== '';
}

export function containsUnsafeTextCharacter(text: string): boolean {
  return text.match(UNSAFE_TEXT_CHARACTERS) !== null;
}

export function stripUnsafeTextCharacters(text: string): string {
  return text.replace(UNSAFE_TEXT_CHARACTERS, '');
}

export function splitIntoSafeLines(text: string): string[] {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).map((line) => line.split('\t').map(stripUnsafeTextCharacters).join('\t'));
}

export function listKnownPropertyKeys(schema: GraphSchema, kind: string): string[] | null {
  const properties = schema.kinds[kind]?.properties;
  if (properties === undefined) return null;
  if (!('shape' in properties) || typeof properties.shape !== 'object' || properties.shape === null) return null;
  return Object.keys(properties.shape);
}

export function describeUnknownKind(schema: GraphSchema, kind: string): string {
  return `unknown kind "${kind}"; known: ${Object.keys(schema.kinds).join(', ')}`;
}

export function describeUnknownEdgeType(schema: GraphSchema, edgeType: string): string {
  return `unknown edge type "${edgeType}"; known: ${Object.keys(schema.edges).join(', ')}`;
}

function isKindAllowed(allowedKinds: readonly string[] | 'any', kind: string): boolean {
  return allowedKinds === 'any' || allowedKinds.includes(kind);
}

export function describeAllowedKinds(allowedKinds: readonly string[] | 'any'): string {
  return allowedKinds === 'any' ? 'any kind' : allowedKinds.join(' | ');
}

export function findEdgeViolation(schema: GraphSchema, candidate: EdgeCandidate): string | null {
  const definition = schema.edges[candidate.edgeType];
  if (!definition) return describeUnknownEdgeType(schema, candidate.edgeType);
  if (!isKindAllowed(definition.fromKinds, candidate.fromKind)) {
    return `${candidate.edgeType} cannot start at a ${candidate.fromKind} (${candidate.fromId}); allowed: ${describeAllowedKinds(definition.fromKinds)}`;
  }
  if (!isKindAllowed(definition.toKinds, candidate.toKind)) {
    return `${candidate.edgeType} cannot point at a ${candidate.toKind} (${candidate.toId}); allowed: ${describeAllowedKinds(definition.toKinds)}`;
  }
  if (candidate.fromId === candidate.toId) {
    return `${candidate.fromId} cannot ${candidate.edgeType} itself`;
  }
  const isAtOutgoingLimit = definition.maxOutgoingPerNode !== undefined && candidate.existingOutgoingCount >= definition.maxOutgoingPerNode;
  if (isAtOutgoingLimit) {
    return `${candidate.fromId} already has ${candidate.existingOutgoingCount} ${candidate.edgeType} edge(s); limit is ${definition.maxOutgoingPerNode}`;
  }
  if (definition.isAcyclic && candidate.targetReachesSource) {
    return `${candidate.fromId} ${candidate.edgeType} ${candidate.toId} would create a cycle`;
  }
  return null;
}

export function parseNodeProperties(schema: GraphSchema, kind: string, rawProperties: unknown): { properties: Record<string, unknown> } | { error: string } {
  const kindDefinition = schema.kinds[kind];
  if (!kindDefinition) return { error: describeUnknownKind(schema, kind) };
  const parsed = kindDefinition.properties.safeParse(rawProperties);
  if (!parsed.success) {
    return { error: `invalid ${kind} properties:\n${z.prettifyError(parsed.error)}` };
  }
  return { properties: parsed.data };
}

function findCycleNodeIds(edges: readonly GraphEdge[]): string[] {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    targetsBySource.set(edge.fromId, [...(targetsBySource.get(edge.fromId) ?? []), edge.toId]);
  }
  const finishedIds = new Set<string>();
  const onPathIds = new Set<string>();
  const cycleNodeIds = new Set<string>();
  const visit = (nodeId: string): void => {
    if (finishedIds.has(nodeId)) return;
    if (onPathIds.has(nodeId)) {
      cycleNodeIds.add(nodeId);
      return;
    }
    onPathIds.add(nodeId);
    for (const targetId of targetsBySource.get(nodeId) ?? []) visit(targetId);
    onPathIds.delete(nodeId);
    finishedIds.add(nodeId);
  };
  for (const sourceId of targetsBySource.keys()) visit(sourceId);
  return [...cycleNodeIds];
}

export function findIntegrityViolations(schema: GraphSchema, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[] {
  const violations: string[] = [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parsed = parseNodeProperties(schema, node.kind, node.properties);
    if ('error' in parsed) violations.push(`${node.id}: ${parsed.error}`);
  }
  const outgoingCountByTypeAndSource = new Map<string, number>();
  for (const edge of edges) {
    const fromNode = nodesById.get(edge.fromId);
    const toNode = nodesById.get(edge.toId);
    if (!fromNode || !toNode) {
      violations.push(`${edge.fromId} ${edge.edgeType} ${edge.toId}: dangling edge`);
      continue;
    }
    const countKey = `${edge.edgeType}\u0000${edge.fromId}`;
    const existingOutgoingCount = outgoingCountByTypeAndSource.get(countKey) ?? 0;
    outgoingCountByTypeAndSource.set(countKey, existingOutgoingCount + 1);
    const violation = findEdgeViolation(schema, {
      edgeType: edge.edgeType,
      fromId: edge.fromId,
      fromKind: fromNode.kind,
      toId: edge.toId,
      toKind: toNode.kind,
      existingOutgoingCount,
      targetReachesSource: false,
    });
    if (violation) violations.push(violation);
  }
  for (const [edgeType, definition] of Object.entries(schema.edges)) {
    if (!definition.isAcyclic) continue;
    const cycleNodeIds = findCycleNodeIds(edges.filter((edge) => edge.edgeType === edgeType));
    if (cycleNodeIds.length > 0) violations.push(`${edgeType} cycle through ${cycleNodeIds.join(', ')}`);
  }
  return violations;
}

import { stripUnsafeTextCharacters } from './graph-schema.ts';
import type { GraphEdge, GraphNode, GraphSchema } from './graph-schema.ts';
import { isTaskClosed, rankNextActions } from './personal-schema.ts';
import type { NextActionCandidate } from './personal-schema.ts';
import type { GraphStore } from './graph-store.ts';

function resolveProjectId(taskId: string, projectIdByNode: ReadonlyMap<string, string>, parentIdByTask: ReadonlyMap<string, string>): string | undefined {
  const visitedIds = new Set<string>();
  let currentId: string | undefined = taskId;
  while (currentId !== undefined && !visitedIds.has(currentId)) {
    const projectId = projectIdByNode.get(currentId);
    if (projectId !== undefined) return projectId;
    visitedIds.add(currentId);
    currentId = parentIdByTask.get(currentId);
  }
  return undefined;
}

export function collectNextActions(store: GraphStore): NextActionCandidate[] {
  const tasks = store.listNodes('task');
  const nodesById = new Map(store.listNodes().map((node) => [node.id, node]));
  const openBlockerIdsByTask = new Map<string, string[]>();
  for (const edge of store.listEdges('blocks')) {
    if (isTaskClosed(nodesById.get(edge.fromId)?.properties.status)) continue;
    openBlockerIdsByTask.set(edge.toId, [...(openBlockerIdsByTask.get(edge.toId) ?? []), edge.fromId]);
  }
  const projectIdByNode = new Map(store.listEdges('part_of').map((edge) => [edge.fromId, edge.toId]));
  const parentIdByTask = new Map(store.listEdges('subtask_of').map((edge) => [edge.fromId, edge.toId]));
  const candidates = tasks.map((task): NextActionCandidate => {
    const projectId = resolveProjectId(task.id, projectIdByNode, parentIdByTask);
    const projectStatus = projectId === undefined ? undefined : nodesById.get(projectId)?.properties.status;
    return {
      id: task.id,
      title: task.title,
      status: String(task.properties.status),
      priority: String(task.properties.priority),
      due: typeof task.properties.due === 'string' ? task.properties.due : undefined,
      projectStatus: typeof projectStatus === 'string' ? projectStatus : undefined,
      openBlockerIds: openBlockerIdsByTask.get(task.id) ?? [],
    };
  });
  return rankNextActions(candidates);
}

function formatPropertyList(properties: Record<string, unknown>): string {
  return Object.entries(properties).map(([key, value]) => `${key}=${stripUnsafeTextCharacters(String(value))}`).join(' ');
}

export function formatNodeLine(node: GraphNode): string {
  const propertyList = formatPropertyList(node.properties);
  return `${node.id.padEnd(6)} ${node.kind.padEnd(9)} ${node.title}${propertyList === '' ? '' : `  [${propertyList}]`}`;
}

function quoteBody(body: string): string {
  if (body === '') return '';
  return body.split(/\r\n|[\r\n\u2028\u2029]/).map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

export function renderMarkdown(schema: GraphSchema, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  const titleById = new Map(nodes.map((node) => [node.id, node.title]));
  const describeEdge = (edge: GraphEdge, perspectiveId: string): string => {
    const isOutgoing = edge.fromId === perspectiveId;
    const otherId = isOutgoing ? edge.toId : edge.fromId;
    const relation = isOutgoing ? edge.edgeType : `${edge.edgeType} (from)`;
    return `- ${relation}: ${otherId} ${titleById.get(otherId) ?? ''}`.trimEnd();
  };
  const sections = Object.keys(schema.kinds).map((kind) => {
    const kindNodes = nodes.filter((node) => node.kind === kind);
    if (kindNodes.length === 0) return '';
    const nodeBlocks = kindNodes.map((node) => {
      const relatedEdges = edges.filter((edge) => edge.fromId === node.id || edge.toId === node.id);
      return [
        `### ${node.id} ${node.title}`,
        formatPropertyList(node.properties),
        ...relatedEdges.map((edge) => describeEdge(edge, node.id)),
        quoteBody(node.body),
      ].filter((line) => line !== '').join('\n');
    });
    return [`## ${kind}`, ...nodeBlocks].join('\n\n');
  });
  return `${[`# ${schema.name} graph`, ...sections.filter((section) => section !== '')].join('\n\n')}\n`;
}

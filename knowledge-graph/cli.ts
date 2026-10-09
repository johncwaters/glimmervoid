import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildCoherenceDelta, inferRecordKind } from './coherence-delta.ts';
import type { RepoReport, TrackedRecord } from './coherence-delta.ts';
import { readRepoSnapshot } from './coherence-source.ts';
import type { CoherenceRunner } from './coherence-source.ts';
import { describeAllowedKinds, listKnownPropertyKeys, stripUnsafeTextCharacters } from './graph-schema.ts';
import type { GraphSchema } from './graph-schema.ts';
import { openGraphStore } from './graph-store.ts';
import type { GraphStore } from './graph-store.ts';
import { collectNextActions, formatNodeLine, renderMarkdown } from './graph-views.ts';
import { personalSchema } from './personal-schema.ts';

const schemasByName: Record<string, GraphSchema> = { personal: personalSchema };

const writeCommandNames = new Set(['add', 'set', 'rm', 'link', 'unlink', 'track']);

const SinceTimestamp = z.iso.datetime({ offset: true });

const usage = `glimmervoid kg: a typed, local-first knowledge and task graph (experimental)

  glimmervoid kg schema                              kinds, their fields, and allowed edges
  glimmervoid kg add <kind> <title> [key=value...]   create a node (--body text)
  glimmervoid kg set <id> [key=value...]             change fields; title= and body= also work; key= clears
  glimmervoid kg rm <id>                             delete a node and its edges
  glimmervoid kg link <from> <edge> <to>             add a typed edge, e.g. kg link T-1 blocks T-2
  glimmervoid kg unlink <from> <edge> <to>
  glimmervoid kg show <id>                           a node with every edge in and out
  glimmervoid kg ls [kind] [key=value...]            list nodes, filtered by fields
  glimmervoid kg find <text>                         full-text search over titles and bodies
  glimmervoid kg next                                unblocked todo/doing tasks in active projects, ranked
  glimmervoid kg chain <id> [edge] [--incoming]      walk an edge transitively; bare "kg chain T-3" lists everything blocking T-3
  glimmervoid kg check                               re-validate every node and edge against the schema
  glimmervoid kg export                              the whole graph as markdown
  glimmervoid kg track <id> <repo> <recordId>        point a kg node at a Coherence work order (wrk-...) or decision (d-...)
  glimmervoid kg delta [id] [--since <iso time>]     what the tracked Coherence records did, and where kg and the ledger disagree

  --graph <name>   which schema (default personal)    --db <path>   database file (default <glimmervoid home>/knowledge-graph/<graph>.sqlite)
  --json           machine-readable output`;

export type KnowledgeGraphCliDependencies = {
  defaultDatabaseDirectory: string;
  runCoherence: CoherenceRunner;
  writeOutput: (text: string) => void;
  writeError: (text: string) => void;
};

type CommandContext = {
  store: GraphStore;
  positionals: string[];
  body: string | undefined;
  since: string | undefined;
  isIncoming: boolean;
  isJson: boolean;
  runCoherence: CoherenceRunner;
  writeOutput: (text: string) => void;
};

function splitAssignments(tokens: readonly string[]): Record<string, string> {
  const assignments: Record<string, string> = {};
  for (const token of tokens) {
    const separatorIndex = token.indexOf('=');
    if (separatorIndex <= 0) throw new Error(`expected key=value, got "${token}"`);
    assignments[token.slice(0, separatorIndex)] = token.slice(separatorIndex + 1);
  }
  return assignments;
}

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) throw new Error(`missing <${name}>\n\n${usage}`);
  return value;
}

function readEdgeArguments(positionals: readonly string[]): { fromId: string; edgeType: string; toId: string } {
  return {
    fromId: requirePositional(positionals, 1, 'from'),
    edgeType: requirePositional(positionals, 2, 'edge'),
    toId: requirePositional(positionals, 3, 'to'),
  };
}

function collectTrackedRecords(store: GraphStore, scopeNodeId: string | undefined): TrackedRecord[] {
  const nodesById = new Map(store.listNodes().map((node) => [node.id, node]));
  const projectIdByNode = new Map(store.listEdges('part_of').map((edge) => [edge.fromId, edge.toId]));
  const isInScope = (nodeId: string) => scopeNodeId === undefined || nodeId === scopeNodeId || projectIdByNode.get(nodeId) === scopeNodeId;
  return store.listEdges('tracked_by').filter((edge) => isInScope(edge.fromId)).flatMap((edge): TrackedRecord[] => {
    const trackingNode = nodesById.get(edge.fromId);
    const pointer = nodesById.get(edge.toId);
    if (!trackingNode || !pointer) return [];
    const record = inferRecordKind(String(pointer.properties.recordId));
    if (record === null) return [];
    const trackingStatus = trackingNode.properties.status;
    return [{
      trackingNodeId: trackingNode.id,
      trackingKind: trackingNode.kind,
      trackingStatus: typeof trackingStatus === 'string' ? trackingStatus : undefined,
      recordNodeId: pointer.id,
      repo: String(pointer.properties.repo),
      record,
      recordId: String(pointer.properties.recordId),
    }];
  });
}

function renderRepoReport(report: RepoReport): string {
  if (!report.isAvailable) {
    const recordLines = report.records.map((tracked) => `  ${tracked.trackingNodeId} -> ${tracked.recordNodeId} ${tracked.recordId}  (not checked)`);
    return [`${stripUnsafeTextCharacters(report.repo)}  unavailable: ${report.reason}`, ...recordLines].join('\n');
  }
  const recordBlocks = report.records.map((recordReport) => [
    `  ${recordReport.tracked.trackingNodeId} -> ${recordReport.tracked.recordNodeId} ${recordReport.tracked.record.padEnd(8)} ${recordReport.state.padEnd(16)} ${recordReport.label}`,
    ...recordReport.findings.map((finding) => `       ! ${finding.kind}: ${finding.detail}`),
    ...recordReport.decisions.map((decision) => `       decision ${decision.id}${decision.isRetracted ? ' (retracted)' : ''} ${decision.chose}`),
  ].join('\n'));
  return [`${stripUnsafeTextCharacters(report.repo)}  heading: ${report.heading}${report.headingReasons.length === 0 ? '' : ` (${report.headingReasons.join('; ')})`}`, ...recordBlocks].join('\n');
}

function print(context: CommandContext, jsonValue: unknown, text: string): number {
  context.writeOutput(`${context.isJson ? JSON.stringify(jsonValue, null, 2) : text}\n`);
  return 0;
}

function describeSchema(schema: GraphSchema): string {
  const kindLines = Object.entries(schema.kinds).map(([kind, definition]) => {
    const shape = (listKnownPropertyKeys(schema, kind) ?? []).join(', ');
    return `  ${kind} (${definition.idPrefix}-n): ${definition.description}${shape === '' ? '' : `\n      fields: ${shape}`}`;
  });
  const edgeLines = Object.entries(schema.edges).map(([edgeType, definition]) => {
    const limits = [
      definition.maxOutgoingPerNode === undefined ? '' : `max ${definition.maxOutgoingPerNode}`,
      definition.isAcyclic ? 'acyclic' : '',
    ].filter((limit) => limit !== '').join(', ');
    return `  ${edgeType}: ${describeAllowedKinds(definition.fromKinds)} -> ${describeAllowedKinds(definition.toKinds)}${limits === '' ? '' : ` (${limits})`}  ${definition.description}`;
  });
  return [`graph "${schema.name}" v${schema.version}`, 'kinds:', ...kindLines, 'edges:', ...edgeLines].join('\n');
}

const commands: Record<string, (context: CommandContext) => number | undefined> = {
  schema: (context) => print(context, context.store.schema, describeSchema(context.store.schema)),
  add: (context) => {
    const kind = requirePositional(context.positionals, 1, 'kind');
    const title = requirePositional(context.positionals, 2, 'title');
    const node = context.store.addNode(kind, title, splitAssignments(context.positionals.slice(3)), context.body ?? '');
    print(context, node, formatNodeLine(node));
  },
  set: (context) => {
    const id = requirePositional(context.positionals, 1, 'id');
    const { title, body, ...properties } = splitAssignments(context.positionals.slice(2));
    const node = context.store.updateNode(id, { title, body: context.body ?? body, properties });
    print(context, node, formatNodeLine(node));
  },
  rm: (context) => {
    const id = requirePositional(context.positionals, 1, 'id');
    context.store.removeNode(id);
    print(context, { removed: id }, `removed ${id}`);
  },
  link: (context) => {
    const { fromId, edgeType, toId } = readEdgeArguments(context.positionals);
    const edge = context.store.link(fromId, edgeType, toId);
    print(context, edge, `${edge.fromId} ${edge.edgeType} ${edge.toId}`);
  },
  unlink: (context) => {
    const { fromId, edgeType, toId } = readEdgeArguments(context.positionals);
    const wasRemoved = context.store.unlink(fromId, edgeType, toId);
    print(context, { removed: wasRemoved }, wasRemoved ? 'unlinked' : 'no such edge');
  },
  show: (context) => {
    const node = context.store.requireNode(requirePositional(context.positionals, 1, 'id'));
    const outgoing = context.store.outgoingEdges(node.id);
    const incoming = context.store.incomingEdges(node.id);
    const titleOf = (id: string) => context.store.getNode(id)?.title ?? '?';
    const lines = [
      formatNodeLine(node),
      ...outgoing.map((edge) => `  -> ${edge.edgeType} ${edge.toId} ${titleOf(edge.toId)}`),
      ...incoming.map((edge) => `  <- ${edge.edgeType} ${edge.fromId} ${titleOf(edge.fromId)}`),
      node.body === '' ? '' : `\n${node.body}`,
    ];
    print(context, { node, outgoing, incoming }, lines.filter((line) => line !== '').join('\n'));
  },
  ls: (context) => {
    const kind = context.positionals[1]?.includes('=') ? undefined : context.positionals[1];
    const filterTokens = context.positionals.slice(kind === undefined ? 1 : 2);
    const nodes = context.store.listNodes(kind, splitAssignments(filterTokens));
    print(context, nodes, nodes.map(formatNodeLine).join('\n') || '(none)');
  },
  find: (context) => {
    const nodes = context.store.search(context.positionals.slice(1).join(' '));
    print(context, nodes, nodes.map(formatNodeLine).join('\n') || '(no matches)');
  },
  next: (context) => {
    const nextActions = collectNextActions(context.store);
    const lines = nextActions.map((action) => `${action.id.padEnd(6)} ${action.priority} ${action.status.padEnd(5)} ${action.title}${action.due === undefined ? '' : `  due ${action.due}`}`);
    print(context, nextActions, lines.join('\n') || '(nothing actionable)');
  },
  chain: (context) => {
    const id = requirePositional(context.positionals, 1, 'id');
    const edgeType = context.positionals[2] ?? 'blocks';
    const steps = context.store.walk(id, edgeType, context.isIncoming || context.positionals[2] === undefined ? 'incoming' : 'outgoing');
    const lines = steps.map((step) => `${'  '.repeat(step.depth - 1)}${formatNodeLine(step.node)}`);
    print(context, steps, lines.join('\n') || '(empty)');
  },
  check: (context) => {
    const violations = context.store.checkIntegrity();
    print(context, violations, violations.join('\n') || 'ok: every node and edge matches the schema');
    return violations.length > 0 ? 1 : 0;
  },
  track: (context) => {
    const trackingNode = context.store.requireNode(requirePositional(context.positionals, 1, 'id'));
    const repo = realpathSync(resolve(requirePositional(context.positionals, 2, 'repo')));
    const recordId = requirePositional(context.positionals, 3, 'recordId');
    const record = inferRecordKind(recordId);
    if (record === null) throw new Error(`"${recordId}" is neither a work order id (wrk-...) nor a decision id (d-...)`);
    const snapshot = readRepoSnapshot(repo, context.runCoherence);
    if (!snapshot.isAvailable) throw new Error(`cannot verify ${recordId}: ${snapshot.reason}`);
    const label = record === 'work'
      ? snapshot.workOrders.find((workOrder) => workOrder.id === recordId)?.objective
      : snapshot.decisions.find((decision) => decision.id === recordId)?.chose;
    if (label === undefined) throw new Error(`${recordId} is not in the Coherence ledger at ${repo}`);
    const { pointer, edge } = context.store.transaction(() => {
      const trackedPointer = context.store.listNodes('coherence_record', { repo, recordId })[0]
        ?? context.store.addNode('coherence_record', label, { repo, record, recordId });
      return { pointer: trackedPointer, edge: context.store.link(trackingNode.id, 'tracked_by', trackedPointer.id) };
    });
    print(context, { pointer, edge }, `${trackingNode.id} tracked_by ${pointer.id} (${record} ${recordId}: ${label})`);
  },
  delta: (context) => {
    const scopeNodeId = context.positionals[1];
    if (scopeNodeId !== undefined) context.store.requireNode(scopeNodeId);
    const trackedRecords = collectTrackedRecords(context.store, scopeNodeId);
    const repos = [...new Set(trackedRecords.map((tracked) => tracked.repo))];
    const snapshotsByRepo = new Map(repos.map((repo) => [repo, readRepoSnapshot(repo, context.runCoherence)]));
    const reports = buildCoherenceDelta(trackedRecords, snapshotsByRepo, context.since);
    print(context, reports, reports.map(renderRepoReport).join('\n\n') || '(nothing tracked; use glimmervoid kg track)');
  },
  export: (context) => {
    context.writeOutput(renderMarkdown(context.store.schema, context.store.listNodes(), context.store.listEdges()));
  },
};

function resolveDatabasePath(requestedPath: string | undefined, commandName: string, defaultPath: string): string {
  if (requestedPath === undefined) return defaultPath;
  if (requestedPath.trim() === '') throw new Error('--db needs a database file path');
  if (writeCommandNames.has(commandName) || existsSync(requestedPath)) return requestedPath;
  throw new Error(`no knowledge graph database at ${requestedPath}; check --db, or create it with a write such as kg add`);
}

function runCommandLine(commandArguments: string[], dependencies: KnowledgeGraphCliDependencies): number {
  const { values, positionals } = parseArgs({
    args: commandArguments,
    allowPositionals: true,
    options: {
      graph: { type: 'string', default: 'personal' },
      db: { type: 'string' },
      body: { type: 'string' },
      since: { type: 'string' },
      incoming: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const commandName = positionals[0];
  const command = commandName === undefined ? undefined : commands[commandName];
  if (values.help || commandName === undefined || command === undefined) {
    dependencies.writeOutput(`${usage}\n`);
    return values.help ? 0 : 1;
  }
  const schema = schemasByName[values.graph];
  if (!schema) throw new Error(`unknown graph "${values.graph}"; known: ${Object.keys(schemasByName).join(', ')}`);
  if (values.since !== undefined && !SinceTimestamp.safeParse(values.since).success) {
    throw new Error(`--since needs an ISO 8601 timestamp with Z or an offset, e.g. 2026-10-09T09:00:00Z; got "${values.since}"`);
  }
  const databasePath = resolveDatabasePath(values.db, commandName, join(dependencies.defaultDatabaseDirectory, `${schema.name}.sqlite`));
  mkdirSync(dirname(databasePath), { recursive: true });
  const store = openGraphStore(databasePath, schema);
  try {
    return command({
      store,
      positionals,
      body: values.body,
      since: values.since,
      isIncoming: values.incoming,
      isJson: values.json,
      runCoherence: dependencies.runCoherence,
      writeOutput: dependencies.writeOutput,
    }) ?? 0;
  } finally {
    store.close();
  }
}

export function runKnowledgeGraphCli(commandArguments: string[], dependencies: KnowledgeGraphCliDependencies): number {
  try {
    return runCommandLine(commandArguments, dependencies);
  } catch (error) {
    dependencies.writeError(`kg: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

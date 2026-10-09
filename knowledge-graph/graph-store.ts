import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { containsUnsafeTextCharacter, describeUnknownEdgeType, describeUnknownKind, findEdgeViolation, findIntegrityViolations, hasVisibleText, listKnownPropertyKeys, parseNodeProperties } from './graph-schema.ts';
import type { GraphEdge, GraphNode, GraphSchema } from './graph-schema.ts';

const NodeRow = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  properties: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const EdgeRow = z.object({
  edge_type: z.string(),
  from_id: z.string(),
  to_id: z.string(),
  created_at: z.string(),
});

const MetaRow = z.object({ value: z.string() });
const ColumnNameRow = z.object({ name: z.string() });
const CountRow = z.object({ edge_count: z.number() });
const NumberRow = z.object({ last_number: z.number() });
const NeighbourRow = z.object({ id: z.string() });
const SqliteBusyError = z.looseObject({ errcode: z.literal(5) });

const tableDefinitions = `
  CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    body TEXT NOT NULL DEFAULT '',
    properties TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS nodes_by_kind ON nodes (kind);
  CREATE TABLE IF NOT EXISTS edges (
    edge_type TEXT NOT NULL,
    from_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (edge_type, from_id, to_id)
  );
  CREATE INDEX IF NOT EXISTS edges_by_target ON edges (to_id, edge_type);
  CREATE TABLE IF NOT EXISTS id_counters (prefix TEXT PRIMARY KEY, last_number INTEGER NOT NULL);
  CREATE VIRTUAL TABLE IF NOT EXISTS node_search USING fts5 (id UNINDEXED, title, body);
`;

type NodeChanges = {
  title?: string;
  body?: string;
  properties?: Record<string, unknown>;
};

type WalkStep = { node: GraphNode; depth: number };

function toGraphNode(row: unknown): GraphNode {
  const parsedRow = NodeRow.parse(row);
  return {
    id: parsedRow.id,
    kind: parsedRow.kind,
    title: parsedRow.title,
    body: parsedRow.body,
    properties: z.record(z.string(), z.unknown()).parse(JSON.parse(parsedRow.properties)),
    createdAt: parsedRow.created_at,
    updatedAt: parsedRow.updated_at,
  };
}

function toGraphEdge(row: unknown): GraphEdge {
  const parsedRow = EdgeRow.parse(row);
  return { edgeType: parsedRow.edge_type, fromId: parsedRow.from_id, toId: parsedRow.to_id, createdAt: parsedRow.created_at };
}

function toSearchExpression(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' ');
}

function withoutEmptyValues(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== ''));
}

const BUSY_TIMEOUT_MS = 5_000;
const JOURNAL_SWITCH_RETRY_MS = 10;

function normalizeTitle(title: string): string {
  const trimmedTitle = title.trim();
  if (!hasVisibleText(trimmedTitle)) throw new Error('title must not be empty');
  if (containsUnsafeTextCharacter(trimmedTitle)) throw new Error('title must be one line without control or bidi characters');
  return trimmedTitle;
}

type DatabaseOwnership = { kind: 'fresh' } | { kind: 'foreign' } | { kind: 'owned'; schemaName: string };

function readOwnership(database: DatabaseSync): DatabaseOwnership {
  const hasSchemaObjects = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' LIMIT 1").get() !== undefined;
  if (!hasSchemaObjects) return { kind: 'fresh' };
  const metaColumnNames = database.prepare("SELECT name FROM pragma_table_info('graph_meta')").all().map((row) => ColumnNameRow.parse(row).name);
  if (!metaColumnNames.includes('key') || !metaColumnNames.includes('value')) return { kind: 'foreign' };
  const storedName = MetaRow.safeParse(database.prepare("SELECT value FROM graph_meta WHERE key = 'schema_name'").get());
  return storedName.success ? { kind: 'owned', schemaName: storedName.data.value } : { kind: 'foreign' };
}

function refuseUnlessClaimable(ownership: DatabaseOwnership, databasePath: string, schema: GraphSchema): void {
  if (ownership.kind === 'foreign') throw new Error(`${databasePath} is not a knowledge graph database; refusing to claim it`);
  if (ownership.kind === 'owned' && ownership.schemaName !== schema.name) {
    throw new Error(`${databasePath} belongs to the "${ownership.schemaName}" graph, not "${schema.name}"`);
  }
}

function runInTransaction<T>(database: DatabaseSync, work: () => T, beginStatement: 'BEGIN IMMEDIATE' | 'BEGIN DEFERRED' = 'BEGIN IMMEDIATE'): T {
  if (database.isTransaction) return work();
  database.exec(beginStatement);
  try {
    const value = work();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function tryEnableWriteAheadLog(database: DatabaseSync, deadlineMs: number): boolean {
  try {
    database.exec('PRAGMA journal_mode = WAL');
    return true;
  } catch (error) {
    if (SqliteBusyError.safeParse(error).success && Date.now() < deadlineMs) return false;
    throw error;
  }
}

function enableWriteAheadLog(database: DatabaseSync): void {
  const deadlineMs = Date.now() + BUSY_TIMEOUT_MS;
  const retryPause = new Int32Array(new SharedArrayBuffer(4));
  while (!tryEnableWriteAheadLog(database, deadlineMs)) Atomics.wait(retryPause, 0, 0, JOURNAL_SWITCH_RETRY_MS);
}

function claimDatabase(database: DatabaseSync, databasePath: string, schema: GraphSchema): void {
  refuseUnlessClaimable(readOwnership(database), databasePath, schema);
  database.exec('PRAGMA foreign_keys = ON');
  runInTransaction(database, () => {
    const ownership = readOwnership(database);
    refuseUnlessClaimable(ownership, databasePath, schema);
    database.exec(tableDefinitions);
    if (ownership.kind !== 'fresh') return;
    database.prepare("INSERT INTO graph_meta (key, value) VALUES ('schema_name', ?), ('schema_version', ?)").run(schema.name, String(schema.version));
  });
  enableWriteAheadLog(database);
}

export type GraphStore = ReturnType<typeof openGraphStore>;

export function openGraphStore(databasePath: string, schema: GraphSchema, currentTimestamp: () => string = () => new Date().toISOString()) {
  const database = new DatabaseSync(databasePath, { timeout: BUSY_TIMEOUT_MS });
  try {
    claimDatabase(database, databasePath, schema);
  } catch (error) {
    database.close();
    throw error;
  }
  const transaction = <T>(work: () => T): T => runInTransaction(database, work);

  const getNode = (id: string): GraphNode | null => {
    const row = database.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    return row === undefined ? null : toGraphNode(row);
  };

  const requireNode = (id: string): GraphNode => {
    const node = getNode(id);
    if (!node) throw new Error(`no node with id ${id}`);
    return node;
  };

  const writeSearchEntry = (node: GraphNode): void => {
    database.prepare('DELETE FROM node_search WHERE id = ?').run(node.id);
    database.prepare('INSERT INTO node_search (id, title, body) VALUES (?, ?, ?)').run(node.id, node.title, node.body);
  };

  const claimNextId = (idPrefix: string): string => {
    const row = database
      .prepare('INSERT INTO id_counters (prefix, last_number) VALUES (?, 1) ON CONFLICT (prefix) DO UPDATE SET last_number = last_number + 1 RETURNING last_number')
      .get(idPrefix);
    return `${idPrefix}-${NumberRow.parse(row).last_number}`;
  };

  const parsePropertiesOrThrow = (kind: string, rawProperties: unknown): Record<string, unknown> => {
    const parsed = parseNodeProperties(schema, kind, rawProperties);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed.properties;
  };

  const addNode = (kind: string, title: string, rawProperties: Record<string, unknown> = {}, body = ''): GraphNode => {
    const properties = parsePropertiesOrThrow(kind, withoutEmptyValues(rawProperties));
    const normalizedTitle = normalizeTitle(title);
    const idPrefix = schema.kinds[kind]?.idPrefix ?? kind;
    return transaction(() => {
      const timestamp = currentTimestamp();
      const id = claimNextId(idPrefix);
      database
        .prepare('INSERT INTO nodes (id, kind, title, body, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, kind, normalizedTitle, body, JSON.stringify(properties), timestamp, timestamp);
      const node = requireNode(id);
      writeSearchEntry(node);
      return node;
    });
  };

  const updateNode = (id: string, changes: NodeChanges): GraphNode => {
    const title = changes.title === undefined ? undefined : normalizeTitle(changes.title);
    return transaction(() => {
      const existing = requireNode(id);
      const mergedProperties = withoutEmptyValues({ ...existing.properties, ...changes.properties });
      const properties = parsePropertiesOrThrow(existing.kind, mergedProperties);
      database
        .prepare('UPDATE nodes SET title = ?, body = ?, properties = ?, updated_at = ? WHERE id = ?')
        .run(title ?? existing.title, changes.body ?? existing.body, JSON.stringify(properties), currentTimestamp(), id);
      const node = requireNode(id);
      writeSearchEntry(node);
      return node;
    });
  };

  const removeNode = (id: string): void => {
    requireNode(id);
    transaction(() => {
      database.prepare('DELETE FROM nodes WHERE id = ?').run(id);
      database.prepare('DELETE FROM node_search WHERE id = ?').run(id);
    });
  };

  const isReachable = (edgeType: string, startId: string, targetId: string): boolean => {
    const row = database
      .prepare(`
        WITH RECURSIVE reachable (id) AS (
          SELECT ?
          UNION
          SELECT edges.to_id FROM edges JOIN reachable ON edges.from_id = reachable.id WHERE edges.edge_type = ?
        )
        SELECT 1 AS found FROM reachable WHERE id = ? LIMIT 1`)
      .get(startId, edgeType, targetId);
    return row !== undefined;
  };

  const findEdge = (fromId: string, edgeType: string, toId: string): GraphEdge | null => {
    const row = database.prepare('SELECT * FROM edges WHERE edge_type = ? AND from_id = ? AND to_id = ?').get(edgeType, fromId, toId);
    return row === undefined ? null : toGraphEdge(row);
  };

  const link = (fromId: string, edgeType: string, toId: string): GraphEdge => {
    const fromNode = requireNode(fromId);
    const toNode = requireNode(toId);
    return transaction(() => {
      const existingEdge = findEdge(fromId, edgeType, toId);
      if (existingEdge) return existingEdge;
      const countRow = database.prepare('SELECT count(*) AS edge_count FROM edges WHERE edge_type = ? AND from_id = ?').get(edgeType, fromId);
      const violation = findEdgeViolation(schema, {
        edgeType,
        fromId,
        fromKind: fromNode.kind,
        toId,
        toKind: toNode.kind,
        existingOutgoingCount: CountRow.parse(countRow).edge_count,
        targetReachesSource: isReachable(edgeType, toId, fromId),
      });
      if (violation) throw new Error(violation);
      const createdAt = currentTimestamp();
      database.prepare('INSERT INTO edges (edge_type, from_id, to_id, created_at) VALUES (?, ?, ?, ?)').run(edgeType, fromId, toId, createdAt);
      return { edgeType, fromId, toId, createdAt };
    });
  };

  const unlink = (fromId: string, edgeType: string, toId: string): boolean =>
    Number(database.prepare('DELETE FROM edges WHERE edge_type = ? AND from_id = ? AND to_id = ?').run(edgeType, fromId, toId).changes) > 0;

  const refuseUnknownFilters = (kind: string | undefined, propertyFilters: Record<string, string>): void => {
    if (kind !== undefined && !schema.kinds[kind]) throw new Error(describeUnknownKind(schema, kind));
    const filterKeys = Object.keys(propertyFilters);
    if (filterKeys.length === 0) return;
    const kindsInScope = kind === undefined ? Object.keys(schema.kinds) : [kind];
    const knownKeysPerKind = kindsInScope.map((kindInScope) => listKnownPropertyKeys(schema, kindInScope));
    if (knownKeysPerKind.includes(null)) return;
    const knownKeys = new Set(knownKeysPerKind.flatMap((keys) => keys ?? []));
    const unknownKey = filterKeys.find((key) => !knownKeys.has(key));
    if (unknownKey !== undefined) throw new Error(`unknown field "${unknownKey}"${kind === undefined ? '' : ` for ${kind}`}; known: ${[...knownKeys].join(', ')}`);
  };

  const listNodes = (kind?: string, propertyFilters: Record<string, string> = {}): GraphNode[] => {
    refuseUnknownFilters(kind, propertyFilters);
    const rows = kind === undefined
      ? database.prepare('SELECT * FROM nodes ORDER BY created_at, id').all()
      : database.prepare('SELECT * FROM nodes WHERE kind = ? ORDER BY created_at, id').all(kind);
    const filterEntries = Object.entries(propertyFilters);
    return rows
      .map(toGraphNode)
      .filter((node) => filterEntries.every(([key, expected]) => String(node.properties[key] ?? '') === expected));
  };

  const listEdges = (edgeType?: string): GraphEdge[] => {
    const rows = edgeType === undefined
      ? database.prepare('SELECT * FROM edges ORDER BY created_at').all()
      : database.prepare('SELECT * FROM edges WHERE edge_type = ? ORDER BY created_at').all(edgeType);
    return rows.map(toGraphEdge);
  };

  const outgoingEdges = (id: string): GraphEdge[] =>
    database.prepare('SELECT * FROM edges WHERE from_id = ? ORDER BY edge_type, to_id').all(id).map(toGraphEdge);

  const incomingEdges = (id: string): GraphEdge[] =>
    database.prepare('SELECT * FROM edges WHERE to_id = ? ORDER BY edge_type, from_id').all(id).map(toGraphEdge);

  const walkWithinSnapshot = (startId: string, edgeType: string, direction: 'outgoing' | 'incoming'): WalkStep[] => {
    requireNode(startId);
    if (!schema.edges[edgeType]) throw new Error(describeUnknownEdgeType(schema, edgeType));
    const neighbourQuery = direction === 'outgoing'
      ? database.prepare('SELECT to_id AS id FROM edges WHERE edge_type = ? AND from_id = ?')
      : database.prepare('SELECT from_id AS id FROM edges WHERE edge_type = ? AND to_id = ?');
    const visitedIds = new Set([startId]);
    const steps: WalkStep[] = [];
    let frontierIds = [startId];
    for (let depth = 1; frontierIds.length > 0; depth += 1) {
      const nextFrontierIds: string[] = [];
      for (const nodeId of frontierIds) {
        for (const row of neighbourQuery.all(edgeType, nodeId)) {
          const neighbourId = NeighbourRow.parse(row).id;
          if (visitedIds.has(neighbourId)) continue;
          visitedIds.add(neighbourId);
          nextFrontierIds.push(neighbourId);
        }
      }
      nextFrontierIds.sort();
      for (const nodeId of nextFrontierIds) steps.push({ node: requireNode(nodeId), depth });
      frontierIds = nextFrontierIds;
    }
    return steps;
  };

  const walk = (startId: string, edgeType: string, direction: 'outgoing' | 'incoming'): WalkStep[] =>
    runInTransaction(database, () => walkWithinSnapshot(startId, edgeType, direction), 'BEGIN DEFERRED');

  const search = (text: string, limit = 20): GraphNode[] => {
    const expression = toSearchExpression(text);
    if (expression === '') return [];
    return database
      .prepare('SELECT nodes.* FROM node_search JOIN nodes ON nodes.id = node_search.id WHERE node_search MATCH ? ORDER BY rank LIMIT ?')
      .all(expression, limit)
      .map(toGraphNode);
  };

  const checkIntegrity = (): string[] => findIntegrityViolations(schema, listNodes(), listEdges());

  return {
    schema,
    addNode,
    updateNode,
    removeNode,
    getNode,
    requireNode,
    link,
    unlink,
    listNodes,
    listEdges,
    outgoingEdges,
    incomingEdges,
    walk,
    search,
    checkIntegrity,
    transaction,
    close: () => database.close(),
  };
}

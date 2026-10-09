import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { findEdgeViolation, findIntegrityViolations, parseNodeProperties } from './graph-schema.ts';
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
const CountRow = z.object({ edge_count: z.number() });
const NumberRow = z.object({ last_number: z.number() });

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

export type NodeChanges = {
  title?: string;
  body?: string;
  properties?: Record<string, unknown>;
};

export type WalkStep = { node: GraphNode; depth: number };

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

function refuseForeignDatabase(database: DatabaseSync, databasePath: string): void {
  const hasGraphMeta = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'graph_meta'").get() !== undefined;
  if (hasGraphMeta) return;
  const hasOtherTables = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get() !== undefined;
  if (!hasOtherTables) return;
  database.close();
  throw new Error(`${databasePath} is not a knowledge graph database; refusing to claim it`);
}

export type GraphStore = ReturnType<typeof openGraphStore>;

export function openGraphStore(databasePath: string, schema: GraphSchema, currentTimestamp: () => string = () => new Date().toISOString()) {
  const database = new DatabaseSync(databasePath);
  refuseForeignDatabase(database, databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  database.exec(tableDefinitions);

  const runInTransaction = <T>(work: () => T): T => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      database.exec('COMMIT');
      return value;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const claimSchemaOwnership = (): void => {
    const storedName = database.prepare("SELECT value FROM graph_meta WHERE key = 'schema_name'").get();
    if (storedName === undefined) {
      database.prepare("INSERT INTO graph_meta (key, value) VALUES ('schema_name', ?), ('schema_version', ?)").run(schema.name, String(schema.version));
      return;
    }
    const ownerName = MetaRow.parse(storedName).value;
    if (ownerName !== schema.name) {
      database.close();
      throw new Error(`${databasePath} belongs to the "${ownerName}" graph, not "${schema.name}"`);
    }
  };
  claimSchemaOwnership();

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
    if (title.trim() === '') throw new Error('title must not be empty');
    const idPrefix = schema.kinds[kind]?.idPrefix ?? kind;
    return runInTransaction(() => {
      const timestamp = currentTimestamp();
      const id = claimNextId(idPrefix);
      database
        .prepare('INSERT INTO nodes (id, kind, title, body, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, kind, title.trim(), body, JSON.stringify(properties), timestamp, timestamp);
      const node = requireNode(id);
      writeSearchEntry(node);
      return node;
    });
  };

  const updateNode = (id: string, changes: NodeChanges): GraphNode => {
    const existing = requireNode(id);
    const mergedProperties = withoutEmptyValues({ ...existing.properties, ...changes.properties });
    const properties = parsePropertiesOrThrow(existing.kind, mergedProperties);
    const title = changes.title?.trim() ?? existing.title;
    if (title === '') throw new Error('title must not be empty');
    return runInTransaction(() => {
      database
        .prepare('UPDATE nodes SET title = ?, body = ?, properties = ?, updated_at = ? WHERE id = ?')
        .run(title, changes.body ?? existing.body, JSON.stringify(properties), currentTimestamp(), id);
      const node = requireNode(id);
      writeSearchEntry(node);
      return node;
    });
  };

  const removeNode = (id: string): void => {
    requireNode(id);
    runInTransaction(() => {
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

  const hasEdge = (fromId: string, edgeType: string, toId: string): boolean =>
    database.prepare('SELECT 1 AS found FROM edges WHERE edge_type = ? AND from_id = ? AND to_id = ?').get(edgeType, fromId, toId) !== undefined;

  const link = (fromId: string, edgeType: string, toId: string): GraphEdge => {
    const fromNode = requireNode(fromId);
    const toNode = requireNode(toId);
    const createdAt = currentTimestamp();
    return runInTransaction(() => {
      if (hasEdge(fromId, edgeType, toId)) return { edgeType, fromId, toId, createdAt };
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
      database.prepare('INSERT INTO edges (edge_type, from_id, to_id, created_at) VALUES (?, ?, ?, ?)').run(edgeType, fromId, toId, createdAt);
      return { edgeType, fromId, toId, createdAt };
    });
  };

  const unlink = (fromId: string, edgeType: string, toId: string): boolean =>
    Number(database.prepare('DELETE FROM edges WHERE edge_type = ? AND from_id = ? AND to_id = ?').run(edgeType, fromId, toId).changes) > 0;

  const listNodes = (kind?: string, propertyFilters: Record<string, string> = {}): GraphNode[] => {
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

  const walk = (startId: string, edgeType: string, direction: 'outgoing' | 'incoming', maxDepth = 25): WalkStep[] => {
    requireNode(startId);
    const [nextColumn, currentColumn] = direction === 'outgoing' ? ['to_id', 'from_id'] : ['from_id', 'to_id'];
    const rows = database
      .prepare(`
        WITH RECURSIVE walked (id, depth) AS (
          SELECT ?, 0
          UNION
          SELECT edges.${nextColumn}, walked.depth + 1 FROM edges JOIN walked ON edges.${currentColumn} = walked.id
          WHERE edges.edge_type = ? AND walked.depth < ?
        )
        SELECT nodes.*, min(walked.depth) AS depth FROM walked JOIN nodes ON nodes.id = walked.id
        WHERE walked.id != ? GROUP BY nodes.id ORDER BY depth, nodes.id`)
      .all(startId, edgeType, maxDepth, startId);
    return rows.map((row) => ({ node: toGraphNode(row), depth: z.object({ depth: z.number() }).parse(row).depth }));
  };

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
    close: () => database.close(),
  };
}

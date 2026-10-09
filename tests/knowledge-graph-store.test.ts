import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { GraphNode, GraphSchema } from '../knowledge-graph/graph-schema.ts';
import { openGraphStore } from '../knowledge-graph/graph-store.ts';
import { collectNextActions, formatNodeLine, renderMarkdown } from '../knowledge-graph/graph-views.ts';
import { personalSchema } from '../knowledge-graph/personal-schema.ts';

const openPersonalGraph = () => openGraphStore(':memory:', personalSchema, () => '2026-10-08T00:00:00.000Z');

const writeLockHolderSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(workerData.databasePath);
database.exec('BEGIN IMMEDIATE');
database.exec(workerData.statementWhileLocked);
parentPort.postMessage('locked');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
database.exec('COMMIT');
database.close();
`;

async function whileAnotherConnectionHoldsTheWriteLock<T>(databasePath: string, statementWhileLocked: string, work: () => T): Promise<T> {
  const lockHolder = new Worker(writeLockHolderSource, { eval: true, workerData: { databasePath, statementWhileLocked, holdMs: 300 } });
  const lockHolderExit = once(lockHolder, 'exit');
  await once(lockHolder, 'message');
  try {
    return work();
  } finally {
    await lockHolderExit;
  }
}

const temporaryDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'kg-test-')), 'graph.sqlite');

test('new nodes get kind-prefixed sequential ids and schema defaults', () => {
  const store = openPersonalGraph();
  const firstTask = store.addNode('task', 'Draft quarterly plan');
  const secondTask = store.addNode('task', 'Review vendor contract', { priority: 'p1' });
  const project = store.addNode('project', 'Vendor migration');
  assert.equal(firstTask.id, 'T-1');
  assert.equal(secondTask.id, 'T-2');
  assert.equal(project.id, 'P-1');
  assert.deepEqual(firstTask.properties, { status: 'todo', priority: 'p2' });
});

test('unknown kinds, unknown fields and bad enum values are rejected', () => {
  const store = openPersonalGraph();
  assert.throws(() => store.addNode('meeting', 'Standup'), /unknown kind "meeting"/);
  assert.throws(() => store.addNode('task', 'Ship it', { owner: 'me' }), /invalid task properties/);
  assert.throws(() => store.addNode('task', 'Ship it', { priority: 'urgent' }), /priority/);
  assert.throws(() => store.addNode('task', 'Ship it', { due: 'next friday' }), /due/);
  assert.throws(() => store.addNode('reference', 'Paper', { url: 'not a url' }), /url/);
  assert.equal(store.listNodes().length, 0);
});

test('edges are typed by source and target kind', () => {
  const store = openPersonalGraph();
  const task = store.addNode('task', 'Write summary');
  const note = store.addNode('note', 'Summary findings');
  const question = store.addNode('question', 'Which vendor is cheaper?');
  assert.throws(() => store.link(task.id, 'part_of', note.id), /cannot point at a note/);
  assert.throws(() => store.link(task.id, 'answers', question.id), /cannot start at a task/);
  assert.throws(() => store.link(task.id, 'owns', note.id), /unknown edge type/);
  store.link(note.id, 'answers', question.id);
  assert.equal(store.incomingEdges(question.id).length, 1);
});

test('a task belongs to at most one project and relinking the same edge is idempotent', () => {
  const store = openPersonalGraph();
  const task = store.addNode('task', 'Write summary');
  const firstProject = store.addNode('project', 'Alpha');
  const secondProject = store.addNode('project', 'Beta');
  store.link(task.id, 'part_of', firstProject.id);
  store.link(task.id, 'part_of', firstProject.id);
  assert.throws(() => store.link(task.id, 'part_of', secondProject.id), /limit is 1/);
});

test('blocks edges refuse cycles, including self loops', () => {
  const store = openPersonalGraph();
  const [first, second, third] = ['Gather data', 'Analyze data', 'Present results'].map((title) => store.addNode('task', title));
  assert.ok(first && second && third);
  store.link(first.id, 'blocks', second.id);
  store.link(second.id, 'blocks', third.id);
  assert.throws(() => store.link(third.id, 'blocks', first.id), /would create a cycle/);
  assert.throws(() => store.link(first.id, 'blocks', first.id), /itself/);
});

test('chain walks every transitive blocker with its depth', () => {
  const store = openPersonalGraph();
  const [first, second, third] = ['Gather data', 'Analyze data', 'Present results'].map((title) => store.addNode('task', title));
  assert.ok(first && second && third);
  store.link(first.id, 'blocks', second.id);
  store.link(second.id, 'blocks', third.id);
  const blockers = store.walk(third.id, 'blocks', 'incoming').map((step) => [step.node.id, step.depth]);
  assert.deepEqual(blockers, [[second.id, 1], [first.id, 2]]);
});

test('next actions skip blocked tasks, closed tasks and tasks in paused projects, ranked doing then priority then due', () => {
  const store = openPersonalGraph();
  const activeProject = store.addNode('project', 'Active work');
  const pausedProject = store.addNode('project', 'On hold', { status: 'paused' });
  const blocker = store.addNode('task', 'Get budget approval', { priority: 'p3' });
  const blocked = store.addNode('task', 'Order hardware', { priority: 'p0' });
  const urgent = store.addNode('task', 'Fix outage report', { priority: 'p0', due: '2026-10-09' });
  const inProgress = store.addNode('task', 'Write runbook', { status: 'doing', priority: 'p2' });
  const finished = store.addNode('task', 'Old chore', { status: 'done' });
  const parked = store.addNode('task', 'Paused project task', { priority: 'p0' });
  store.link(blocker.id, 'blocks', blocked.id);
  store.link(parked.id, 'part_of', pausedProject.id);
  store.link(urgent.id, 'part_of', activeProject.id);
  assert.deepEqual(collectNextActions(store).map((action) => action.id), [inProgress.id, urgent.id, blocker.id]);
  store.updateNode(blocker.id, { properties: { status: 'done' } });
  assert.ok(collectNextActions(store).some((action) => action.id === blocked.id));
  assert.ok(!collectNextActions(store).some((action) => action.id === finished.id));
});

test('updates are re-validated against the schema and empty values clear optional fields', () => {
  const store = openPersonalGraph();
  const task = store.addNode('task', 'Book travel', { due: '2026-11-01' });
  assert.throws(() => store.updateNode(task.id, { properties: { status: 'finished' } }), /status/);
  const cleared = store.updateNode(task.id, { properties: { due: '' }, title: 'Book conference travel' });
  assert.equal(cleared.properties.due, undefined);
  assert.equal(cleared.title, 'Book conference travel');
});

test('full-text search matches title and body prefixes and survives quote characters', () => {
  const store = openPersonalGraph();
  store.addNode('note', 'Postgres vacuum tuning', {}, 'autovacuum_naptime matters for hot tables');
  store.addNode('note', 'Hiring loop notes');
  assert.deepEqual(store.search('autovac').map((node) => node.title), ['Postgres vacuum tuning']);
  assert.deepEqual(store.search('"vacuum'), store.search('vacuum'));
  assert.deepEqual(store.search('   '), []);
});

test('removing a node removes its edges and its search entry', () => {
  const store = openPersonalGraph();
  const task = store.addNode('task', 'Temporary task');
  const project = store.addNode('project', 'Alpha');
  store.link(task.id, 'part_of', project.id);
  store.removeNode(task.id);
  assert.equal(store.listEdges().length, 0);
  assert.deepEqual(store.search('Temporary'), []);
});

test('a database file belongs to one graph schema and refuses another', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'kg-test-')), 'graph.sqlite');
  const factorySchema: GraphSchema = {
    name: 'factory',
    version: 1,
    kinds: { order: { idPrefix: 'O', description: 'A work order', properties: z.strictObject({}) } },
    edges: {},
  };
  openGraphStore(databasePath, personalSchema).close();
  assert.throws(() => openGraphStore(databasePath, factorySchema), /belongs to the "personal" graph/);
  const reopened = openGraphStore(databasePath, personalSchema);
  reopened.addNode('topic', 'Databases');
  reopened.close();
});

test('integrity check is clean for a valid graph and reports rows written behind the schema', () => {
  const store = openPersonalGraph();
  const task = store.addNode('task', 'Valid task');
  assert.deepEqual(store.checkIntegrity(), []);
  const strictTaskKind = personalSchema.kinds.task;
  assert.ok(strictTaskKind);
  const looseSchema: GraphSchema = { ...personalSchema, kinds: { ...personalSchema.kinds, task: { ...strictTaskKind, properties: z.record(z.string(), z.unknown()) } } };
  const sharedPath = join(mkdtempSync(join(tmpdir(), 'kg-test-')), 'graph.sqlite');
  const looseStore = openGraphStore(sharedPath, looseSchema);
  looseStore.addNode('task', 'Drifted task', { status: 'someday' });
  looseStore.close();
  const strictStore = openGraphStore(sharedPath, personalSchema);
  assert.match(strictStore.checkIntegrity().join('\n'), /T-1: invalid task properties/);
  assert.equal(task.id, 'T-1');
});

test('markdown export lists nodes by kind with their edges', () => {
  const store = openPersonalGraph();
  const project = store.addNode('project', 'Alpha');
  const task = store.addNode('task', 'Kickoff', {}, 'Agenda in the shared doc');
  store.link(task.id, 'part_of', project.id);
  const markdown = renderMarkdown(personalSchema, store.listNodes(), store.listEdges());
  assert.match(markdown, /## project\n\n### P-1 Alpha/);
  assert.match(markdown, /### T-1 Kickoff\nstatus=todo priority=p2\n- part_of: P-1 Alpha\n> Agenda in the shared doc/);
});

test('a writer waits for another connection holding the write lock instead of failing as locked', async () => {
  const databasePath = temporaryDatabasePath();
  const store = openGraphStore(databasePath, personalSchema);
  const task = await whileAnotherConnectionHoldsTheWriteLock(databasePath, 'SELECT 1', () => store.addNode('task', 'Written while locked'));
  assert.equal(task.id, 'T-1');
  store.close();
});

test('an update merges onto a change another connection committed while it waited', async () => {
  const databasePath = temporaryDatabasePath();
  const store = openGraphStore(databasePath, personalSchema);
  const task = store.addNode('task', 'Contended task');
  const raisePriority = `UPDATE nodes SET properties = json_set(properties, '$.priority', 'p0') WHERE id = '${task.id}'`;
  const updated = await whileAnotherConnectionHoldsTheWriteLock(databasePath, raisePriority, () => store.updateNode(task.id, { properties: { status: 'doing' } }));
  assert.deepEqual(updated.properties, { status: 'doing', priority: 'p0' });
  store.close();
});

test('a subtask inherits the project of its parent task chain when ranking next actions', () => {
  const store = openPersonalGraph();
  const pausedProject = store.addNode('project', 'On hold', { status: 'paused' });
  const doneProject = store.addNode('project', 'Shipped', { status: 'done' });
  const activeProject = store.addNode('project', 'Live');
  const parent = store.addNode('task', 'Paused parent');
  const child = store.addNode('task', 'Child of paused parent');
  const grandchild = store.addNode('task', 'Grandchild of paused parent');
  const doneParent = store.addNode('task', 'Done project parent');
  const doneChild = store.addNode('task', 'Child in done project');
  const reassigned = store.addNode('task', 'Subtask moved to a live project');
  store.link(parent.id, 'part_of', pausedProject.id);
  store.link(child.id, 'subtask_of', parent.id);
  store.link(grandchild.id, 'subtask_of', child.id);
  store.link(doneParent.id, 'part_of', doneProject.id);
  store.link(doneChild.id, 'subtask_of', doneParent.id);
  store.link(reassigned.id, 'subtask_of', parent.id);
  store.link(reassigned.id, 'part_of', activeProject.id);
  assert.deepEqual(collectNextActions(store).map((action) => action.id), [reassigned.id]);
});

test('titles must be one visible line without control or bidi characters', () => {
  const store = openPersonalGraph();
  const zeroWidthSpace = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);
  const lineSeparator = String.fromCharCode(0x2028);
  const escapeCharacter = String.fromCharCode(0x1b);
  assert.throws(() => store.addNode('task', `${zeroWidthSpace}${zeroWidthSpace}`), /title must not be empty/);
  for (const title of ['Real task\n### T-9 Fake', 'Carriage\rreturn', `Line${lineSeparator}separator`, `Bidi ${rightToLeftOverride}txt.exe`, `Escape ${escapeCharacter}[2J`, 'Tab\tseparated']) {
    assert.throws(() => store.addNode('task', title), /title must be one line/, JSON.stringify(title));
  }
  const task = store.addNode('task', 'Plain title');
  assert.throws(() => store.updateNode(task.id, { title: 'Plain\n- blocks: T-1' }), /title must be one line/);
  assert.throws(() => store.updateNode(task.id, { title: zeroWidthSpace }), /title must not be empty/);
  assert.equal(store.listNodes().length, 1);
});

test('titles keep the zero width joiners Persian words and emoji sequences need', () => {
  const store = openPersonalGraph();
  const zeroWidthNonJoiner = String.fromCharCode(0x200c);
  const zeroWidthJoiner = String.fromCharCode(0x200d);
  const persianTitle = `${String.fromCharCode(0x0645, 0x06cc)}${zeroWidthNonJoiner}${String.fromCharCode(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)}`;
  const emojiTitle = `Family ${String.fromCodePoint(0x1f468)}${zeroWidthJoiner}${String.fromCodePoint(0x1f469)}`;
  const persianTask = store.addNode('task', persianTitle);
  const emojiTask = store.addNode('task', emojiTitle);
  assert.equal(store.getNode(persianTask.id)?.title, persianTitle);
  assert.equal(store.getNode(emojiTask.id)?.title, emojiTitle);
  assert.throws(() => store.addNode('task', zeroWidthJoiner), /title must not be empty/);
  assert.throws(() => store.addNode('task', String.fromCharCode(0xfeff)), /title must not be empty/);
});

test('property values with line breaks cannot forge an export heading or break a listing line', () => {
  const forgedNode: GraphNode = {
    id: 'R-1', kind: 'reference', title: 'Paper', body: '', properties: { medium: 'article', author: 'x\n### T-9 forged' }, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
  };
  const markdown = renderMarkdown(personalSchema, [forgedNode], []);
  assert.deepEqual(markdown.split('\n').filter((line) => line.startsWith('### ')), ['### R-1 Paper']);
  assert.ok(markdown.includes('medium=article author=x### T-9 forged'));
  assert.equal(formatNodeLine(forgedNode).split('\n').length, 1);
});

test('markdown export quotes every body line so a body cannot pose as a heading or an edge', () => {
  const store = openPersonalGraph();
  const blocker = store.addNode('task', 'Real blocker');
  store.addNode('task', 'Victim', {}, '### T-9 Injected heading\r\n- blocks: T-1 Real blocker\n\nlast line');
  const markdown = renderMarkdown(personalSchema, store.listNodes(), store.listEdges());
  assert.ok(markdown.includes('### T-2 Victim\nstatus=todo priority=p2\n> ### T-9 Injected heading\n> - blocks: T-1 Real blocker\n>\n> last line\n'));
  assert.deepEqual(markdown.split('\n').filter((line) => line.startsWith('### ')), [`### ${blocker.id} Real blocker`, '### T-2 Victim']);
  assert.deepEqual(markdown.split('\n').filter((line) => line.startsWith('- ')), []);
});

test('listing by an unknown kind or field, or walking an unknown edge type, is refused', () => {
  const store = openPersonalGraph();
  const task = store.addNode('task', 'Anything');
  assert.throws(() => store.listNodes('badkey'), /unknown kind "badkey"/);
  assert.throws(() => store.listNodes('task', { bogus: 'x' }), /unknown field "bogus" for task/);
  assert.throws(() => store.listNodes(undefined, { bogus: 'x' }), /unknown field "bogus"/);
  assert.deepEqual(store.listNodes(undefined, { status: 'todo' }).map((node) => node.id), [task.id]);
  assert.deepEqual(store.listNodes('task', { priority: 'p2' }).map((node) => node.id), [task.id]);
  assert.throws(() => store.walk(task.id, 'nonsense', 'incoming'), /unknown edge type "nonsense"/);
});

test('a store transaction rolls back every write inside it when one fails', () => {
  const store = openPersonalGraph();
  const reference = store.addNode('reference', 'Vendor price sheet');
  assert.throws(() => store.transaction(() => {
    const pointer = store.addNode('coherence_record', 'Compare prices', { repo: '/repos/vendor', record: 'work', recordId: 'wrk-17ea723e85439d2a' });
    store.link(reference.id, 'tracked_by', pointer.id);
  }), /cannot start at a reference/);
  assert.deepEqual(store.listNodes().map((node) => node.id), [reference.id]);
  assert.equal(store.addNode('coherence_record', 'Compare prices', { repo: '/repos/vendor', record: 'work', recordId: 'wrk-17ea723e85439d2a' }).id, 'C-1');
});

test('a coherence pointer accepts a Windows or POSIX absolute repo path and refuses a relative one', () => {
  const store = openPersonalGraph();
  const windowsPointer = store.addNode('coherence_record', 'Compare prices', { repo: 'C:\\repos\\vendor', record: 'work', recordId: 'wrk-17ea723e85439d2a' });
  assert.equal(windowsPointer.properties.repo, 'C:\\repos\\vendor');
  store.addNode('coherence_record', 'Compare prices', { repo: '/repos/vendor', record: 'work', recordId: 'wrk-17ea723e85439d2a' });
  assert.throws(() => store.addNode('coherence_record', 'Compare prices', { repo: 'repos/vendor', record: 'work', recordId: 'wrk-17ea723e85439d2a' }), /repo/);
});

test('a SQLite file holding unrelated tables is refused and left without graph tables', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'kg-test-')), 'foreign.sqlite');
  const foreignDatabase = new DatabaseSync(databasePath);
  foreignDatabase.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, total INTEGER)');
  foreignDatabase.close();
  assert.throws(() => openGraphStore(databasePath, personalSchema), /not a knowledge graph database/);
  const inspected = new DatabaseSync(databasePath);
  const tableNames = inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  const journalMode = inspected.prepare('PRAGMA journal_mode').get();
  inspected.close();
  assert.deepEqual(tableNames, ['invoices']);
  assert.equal(journalMode?.journal_mode, 'delete');
});

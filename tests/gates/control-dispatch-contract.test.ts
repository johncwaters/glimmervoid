import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ClientMessage, ServerMessage } from '../../shared/contracts/index.ts';
import { readTracked } from '../helpers/tracked-files.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const HANDLER_GROUP_DIR = 'server/control/handlers';

function dispatchTypes(repoPath: string, startMarker: string, endMarker: string): string[] {
  const source = readTracked(repoPath);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${repoPath} no longer has ${startMarker}`);
  assert.notEqual(end, -1, `${repoPath} no longer has ${endMarker}`);
  return [...source.slice(start, end).matchAll(/^\s*['"]([a-z][a-z0-9-]*)['"]\s*:/gm)].map((match) => match[1]);
}

function schemaTypes(schema: typeof ClientMessage | typeof ServerMessage): Set<string> {
  return new Set(schema.options.map((option) => option.shape.type.value));
}

function handlerGroupFiles(): string[] {
  return fs.readdirSync(path.join(REPO_ROOT, HANDLER_GROUP_DIR))
    .filter((name) => name.endsWith('-handlers.ts'))
    .sort()
    .map((name) => `${HANDLER_GROUP_DIR}/${name}`);
}

test('every control handler group claims only contract message types, each type once, and answers only types it handles', () => {
  const clientSchemaTypes = schemaTypes(ClientMessage);
  const groupFiles = handlerGroupFiles();
  assert.ok(groupFiles.length >= 10, `expected the control handler groups under ${HANDLER_GROUP_DIR}, found ${groupFiles.length}`);
  const groupByType = new Map<string, string>();
  const typesClaimedTwice: string[] = [];
  for (const groupFile of groupFiles) {
    const handledTypes = dispatchTypes(groupFile, 'const handlers = {', '} satisfies ControlHandlerTable');
    assert.ok(handledTypes.length > 0, `${groupFile} handles no message type`);
    assert.deepEqual(handledTypes.filter((type) => !clientSchemaTypes.has(type)), [], `${groupFile} handles a type the ClientMessage contract lacks`);
    for (const type of handledTypes) {
      const owner = groupByType.get(type);
      if (owner) typesClaimedTwice.push(`${type}: ${owner} and ${groupFile}`);
      groupByType.set(type, groupFile);
    }
    if (!readTracked(groupFile).includes('const invalidReplies = {')) continue;
    const answeredTypes = dispatchTypes(groupFile, 'const invalidReplies = {', '} satisfies InvalidReplyTable');
    assert.deepEqual(answeredTypes.filter((type) => !handledTypes.includes(type)), [], `${groupFile} answers an invalid request for a type it does not handle`);
  }
  assert.deepEqual(typesClaimedTwice, [], 'a type two groups claim dispatches to whichever merged last');
});

test('the dashboard dispatch table contains only contract message types', () => {
  const serverTypes = dispatchTypes('public/app.ts', 'const messageHandlers = {', 'onControlMessage((msg)');
  const serverSchemaTypes = schemaTypes(ServerMessage);
  assert.deepEqual(serverTypes.filter((type) => !serverSchemaTypes.has(type)), []);
});

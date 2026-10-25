import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientMessage, ServerMessage } from '../../shared/contracts/index.ts';
import { readTracked } from '../helpers/tracked-files.ts';

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

test('control dispatch tables contain only contract message types', () => {
  const clientTypes = dispatchTypes('server/control-handlers.ts', 'const handlers = {', "controlWss.on('connection'");
  const serverTypes = dispatchTypes('public/app.ts', 'const messageHandlers = {', 'onControlMessage((msg)');
  const clientSchemaTypes = schemaTypes(ClientMessage);
  const serverSchemaTypes = schemaTypes(ServerMessage);
  assert.deepEqual(clientTypes.filter((type) => !clientSchemaTypes.has(type)), []);
  assert.deepEqual(serverTypes.filter((type) => !serverSchemaTypes.has(type)), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ClientMessage, ServerMessage } from '../../shared/contracts/index.ts';
import { readTracked } from '../helpers/tracked-files.ts';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

interface HandlerGroupSide {
  name: string;
  directory: string;
  tableStart: string;
  tableEnd: string;
  contract: typeof ClientMessage | typeof ServerMessage;
  minimumGroups: number;
  invalidRepliesEnd?: string;
}

const HANDLER_GROUP_SIDES: readonly HandlerGroupSide[] = [
  { name: 'control', directory: 'server/control/handlers', tableStart: 'const handlers = {', tableEnd: '} satisfies ControlHandlerTable', contract: ClientMessage, minimumGroups: 10, invalidRepliesEnd: '} satisfies InvalidReplyTable' },
  { name: 'dashboard', directory: 'public/boot/handlers', tableStart: 'const messageHandlers = {', tableEnd: '} satisfies DashboardHandlerTable', contract: ServerMessage, minimumGroups: 7 },
];

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

function handlerGroupFiles(directory: string): string[] {
  return fs.readdirSync(path.join(REPO_ROOT, directory))
    .filter((name) => name.endsWith('-handlers.ts'))
    .sort()
    .map((name) => `${directory}/${name}`);
}

function assertInvalidRepliesAnswerHandledTypes(groupFile: string, handledTypes: readonly string[], invalidRepliesEnd: string) {
  if (!readTracked(groupFile).includes('const invalidReplies = {')) return;
  const answeredTypes = dispatchTypes(groupFile, 'const invalidReplies = {', invalidRepliesEnd);
  assert.deepEqual(answeredTypes.filter((type) => !handledTypes.includes(type)), [], `${groupFile} answers an invalid request for a type it does not handle`);
}

for (const side of HANDLER_GROUP_SIDES) {
  test(`every ${side.name} handler group claims only contract message types, each type once, and answers only types it handles`, () => {
    const contractTypes = schemaTypes(side.contract);
    const groupFiles = handlerGroupFiles(side.directory);
    assert.ok(groupFiles.length >= side.minimumGroups, `expected the ${side.name} handler groups under ${side.directory}, found ${groupFiles.length}`);
    const groupByType = new Map<string, string>();
    const typesClaimedTwice: string[] = [];
    for (const groupFile of groupFiles) {
      const handledTypes = dispatchTypes(groupFile, side.tableStart, side.tableEnd);
      assert.ok(handledTypes.length > 0, `${groupFile} handles no message type`);
      assert.deepEqual(handledTypes.filter((type) => !contractTypes.has(type)), [], `${groupFile} handles a type the ${side.name} contract lacks`);
      for (const type of handledTypes) {
        const owner = groupByType.get(type);
        if (owner) typesClaimedTwice.push(`${type}: ${owner} and ${groupFile}`);
        groupByType.set(type, groupFile);
      }
      if (side.invalidRepliesEnd) assertInvalidRepliesAnswerHandledTypes(groupFile, handledTypes, side.invalidRepliesEnd);
    }
    assert.deepEqual(typesClaimedTwice, [], 'a type two groups claim dispatches to whichever merged last');
  });
}

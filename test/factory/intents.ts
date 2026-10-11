import { z } from 'zod';
import { ClientMessage } from '../../shared/contracts/control-messages.ts';
import { FactoryQueueIntentRequest } from '../../shared/contracts/factory.ts';

import type { TargetName } from './targets.ts';

export type ExpectedEnd = 'completed' | 'refused';
export interface Intent {
  name: string;
  target: TargetName | null;
  expectedEnd: ExpectedEnd;
  expectedRefusal: string | null;
  seedProjectId: string;
  request: FactoryQueueIntentRequest;
}

const baseRequest = {
  projectId: 'seed', risk: 'low' as const,
  boundary: 'Only this throwaway repository. Preserve add and existing tests.',
  writeScopes: ['src', 'test'],
};

export const intents: Intent[] = [
  { name: 'gated-one-file-change', target: 'gated-clone', expectedEnd: 'completed', expectedRefusal: null, seedProjectId: 'seed', request: {
    projectId: 'seed', risk: 'low',
    objective: 'Add an exported pure containsLineBreak(text: string): boolean function to shared/text.ts that detects a carriage return or newline. Before editing, search the repository for that name and equivalent behavior; if the name exists, choose another name that reads as natural English. Add one test in the existing tests/shared-text.test.ts file.',
    criteria: ['The function returns true for a carriage return, newline and CRLF, and false for empty text and text without line breaks.', 'One test in tests/shared-text.test.ts covers the function; existing exports and tests remain unchanged.', 'The shipped typecheck, lint and test checks pass.'],
    boundary: 'This is a gated copy of glimmervoid. Change only shared/text.ts and tests/shared-text.test.ts; no other file may change. All merges and pushes stay on this copy\'s local origin. Never access the real checkout or any operator gate.',
    writeScopes: ['shared/text.ts', 'tests'],
  } },
  { name: 'one-file-change', target: 'throwaway', expectedEnd: 'completed', expectedRefusal: null, seedProjectId: 'seed', request: {
    ...baseRequest, objective: 'Add an exported subtract(left, right) function to src/math.js. Change only that file.',
    criteria: ['subtract(7, 3) returns 4; add remains unchanged; npm test passes.'],
  } },
  { name: 'dependent-two-unit-change', target: 'throwaway', expectedEnd: 'completed', expectedRefusal: null, seedProjectId: 'seed', request: {
    ...baseRequest, objective: 'Create exactly two worker units with a ledger dependency. First add multiply(left, right) to src/math.js and merge it. Only after that unit lands, a second worker adds test/multiply.test.js importing multiply. The second unit must depend on the first and must not change src/math.js.',
    criteria: ['multiply(6, 7) returns 42.', 'The second unit depends on the first in the ledger and runs after its merge.', 'npm test includes passing multiplication coverage.'],
  } },
  { name: 'unknown-project-refusal', target: 'throwaway', expectedEnd: 'refused', expectedRefusal: 'Unknown factory project', seedProjectId: 'seed', request: {
    ...baseRequest, projectId: 'unregistered-project', objective: 'Add subtract to src/math.js.',
    criteria: ['The queue refuses this unregistered project with Unknown factory project.'],
  } },
];

export function parseIntentFile(document: unknown): Intent {
  const intentDocument = FactoryQueueIntentRequest.extend({
    type: z.literal('factory-queue-intent').optional(), name: z.string().min(1).optional(),
    expectedEnd: z.enum(['completed', 'refused']).default('completed'),
    expectedRefusal: z.string().trim().min(1).optional(),
  }).passthrough().refine((candidate) => candidate.expectedEnd !== 'refused' || candidate.expectedRefusal !== undefined, {
    path: ['expectedRefusal'], message: 'An intent file with expectedEnd refused must name the refusal reason in expectedRefusal',
  }).parse(document);
  ClientMessage.parse({ type: 'factory-queue-intent', ...intentDocument });
  const request = FactoryQueueIntentRequest.parse(intentDocument);
  return { target: null, name: intentDocument.name ?? 'intent-file', expectedEnd: intentDocument.expectedEnd, expectedRefusal: intentDocument.expectedEnd === 'refused' ? intentDocument.expectedRefusal ?? null : null, seedProjectId: request.projectId, request };
}

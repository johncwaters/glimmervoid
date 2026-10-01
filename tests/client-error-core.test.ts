import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CLIENT_ERROR_REPORTS, buildClientErrorReport, createClientErrorReporter } from '../public/client-error-core.ts';
import { CLIENT_ERROR_STACK_MAX_CHARS } from '../shared/contracts/control-messages.ts';

function errorWithStack(name: string, message: string, frames: string[]): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = [`${name}: ${message}`, ...frames].join('\n');
  return error;
}

test('a client error report keeps the name and frame lines and drops the message, even a multi-line one', () => {
  const report = buildClientErrorReport(errorWithStack('TypeError', 'token abc123\n    at fake (https://alice:pw@host/x.js:1:1)', [
    '    at render (http://localhost/assets/app.js:10:5)',
    'load@http://localhost/assets/app.js:2:1',
  ]));
  assert.deepEqual(report, { name: 'TypeError', stack: '    at render (http://localhost/assets/app.js:10:5)\nload@http://localhost/assets/app.js:2:1' });
});

test('a non-Error rejection is reported by kind only, and a missing reason not at all', () => {
  assert.deepEqual(buildClientErrorReport('secret string'), { name: 'NonError', stack: '' });
  assert.equal(buildClientErrorReport(null), null);
  assert.equal(buildClientErrorReport(undefined), null);
});

test('a client error stack is capped to the contract limit', () => {
  const frames = Array.from({ length: 1000 }, (_, index) => `    at frame${index} (http://localhost/assets/app.js:${index}:1)`);
  const report = buildClientErrorReport(errorWithStack('Error', 'x', frames));
  assert.equal(report?.stack.length, CLIENT_ERROR_STACK_MAX_CHARS);
});

test('the reporter sends each distinct error once and stops at its cap', () => {
  const sentMessages: Record<string, unknown>[] = [];
  const reportClientError = createClientErrorReporter((message) => {
    sentMessages.push(message);
    return true;
  });
  const repeated = errorWithStack('TypeError', 'one', ['    at a (http://localhost/app.js:1:1)']);
  reportClientError(repeated);
  reportClientError(repeated);
  assert.deepEqual(sentMessages, [{ type: 'client-error', name: 'TypeError', stack: '    at a (http://localhost/app.js:1:1)' }]);
  for (let index = 0; index < MAX_CLIENT_ERROR_REPORTS * 2; index += 1) {
    reportClientError(errorWithStack(`Error${index}`, 'x', []));
  }
  assert.equal(sentMessages.length, MAX_CLIENT_ERROR_REPORTS);
});

test('an error the socket could not send is reported again once the socket is open and uses no report slot', () => {
  const sentMessages: Record<string, unknown>[] = [];
  let isSocketOpen = false;
  const reportClientError = createClientErrorReporter((message) => {
    if (!isSocketOpen) return false;
    sentMessages.push(message);
    return true;
  });
  const duringReconnect = errorWithStack('TypeError', 'one', ['    at a (http://localhost/app.js:1:1)']);
  for (let index = 0; index < MAX_CLIENT_ERROR_REPORTS * 2; index += 1) {
    reportClientError(errorWithStack(`Error${index}`, 'x', []));
  }
  reportClientError(duringReconnect);
  assert.equal(sentMessages.length, 0);
  isSocketOpen = true;
  reportClientError(duringReconnect);
  reportClientError(duringReconnect);
  assert.deepEqual(sentMessages, [{ type: 'client-error', name: 'TypeError', stack: '    at a (http://localhost/app.js:1:1)' }]);
});

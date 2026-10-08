import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTING_WEDGE_MS, RECYCLE_AFTER_HIDDEN_MS, decideLivenessAction } from '../public/connection-liveness-core.ts';

test('retryPending reconnects immediately before inspecting the socket', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: true }), 'retry-now');
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: null, retryPending: true }), 'retry-now');
});

test('missing socket starts a new connection', () => {
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: null, retryPending: false }), 'connect');
});

test('connecting socket waits for the browser connection attempt', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false }), 'wait');
});

test('connecting socket wedged past the threshold is replaced', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false, connectingAgeMs: CONNECTING_WEDGE_MS }), 'wait');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 0, retryPending: false, connectingAgeMs: CONNECTING_WEDGE_MS + 1 }), 'connect');
});

test('open socket probes with an application ping', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: false }), 'probe');
});

test('closing and closed sockets start a replacement connection', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 2, retryPending: false }), 'connect');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 3, retryPending: false }), 'connect');
});

test('unknown or absent readyState is treated like no usable socket', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 99, retryPending: false }), 'connect');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: null, retryPending: false }), 'connect');
});

test('a hide at the recycle threshold replaces even an open socket instead of probing it', () => {
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: false, hiddenForMs: RECYCLE_AFTER_HIDDEN_MS - 1 }), 'probe');
  assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: false, hiddenForMs: RECYCLE_AFTER_HIDDEN_MS }), 'connect');
});

test('a long hide replaces a socket in any state', () => {
  for (const readyState of [0, 1, 2, 3, null]) {
    assert.equal(decideLivenessAction({ hasSocket: true, readyState, retryPending: false, hiddenForMs: RECYCLE_AFTER_HIDDEN_MS * 6 }), 'connect');
  }
});

test('a pending retry still fires now after a long hide', () => {
  assert.equal(decideLivenessAction({ hasSocket: false, readyState: null, retryPending: true, hiddenForMs: RECYCLE_AFTER_HIDDEN_MS * 6 }), 'retry-now');
});

test('an unknown hide duration keeps the probe', () => {
  for (const hiddenForMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    assert.equal(decideLivenessAction({ hasSocket: true, readyState: 1, retryPending: false, hiddenForMs }), 'probe');
  }
});

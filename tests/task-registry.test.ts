import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRegistry, 
} from '../session/core/agent-tracker.ts';
import type { TaskRegistryOptions } from '../session/core/agent-tracker.ts';

function makeRegistry(overrides: TaskRegistryOptions = {}) {
  let clock = 1_000_000;
  const registry = createTaskRegistry({ now: () => clock, ...overrides });
  return {
    registry,
    advance: (ms: number) => { clock += ms; },
    at: () => clock,
  };
}

test('a shell declaration outlives the generic agent TTL and drains at its own backstop', () => {
  const { registry, advance } = makeRegistry({ agentTtlMs: 100, shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  advance(100);
  assert.equal(registry.activeCount(), 1);
  assert.equal(registry.hasDeclared(), true);
  advance(100);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.hasDeclared(), false);
});

test('a re-declared shell keeps its first age across Stops and turn resets', () => {
  const { registry, advance, at } = makeRegistry({ shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  advance(100);
  registry.clearDeclared();
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  assert.equal(registry.msUntilNextDrain(at()), 100);
  advance(99);
  assert.equal(registry.activeCount(), 1);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  assert.equal(registry.msUntilNextDrain(at()), 1);
  advance(1);
  assert.equal(registry.activeCount(), 0);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.msUntilNextDrain(at()), null);
});

test('a task id omitted from a later snapshot starts a new age when it returns', () => {
  const { registry, advance } = makeRegistry({ shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  advance(150);
  registry.reconcileDeclared([]);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }]);
  advance(100);
  assert.equal(registry.activeCount(), 1);
});

test('a re-declared teammate ages from its latest snapshot while a re-declared shell ages from first sighting', () => {
  const { registry, advance, at } = makeRegistry({ teammateTaskTtlMs: 90_000, shellTaskTtlMs: 100_000 });
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 'b1', type: 'shell' }]);
  advance(60_000);
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 'b1', type: 'shell' }]);
  assert.equal(registry.msUntilNextDrain(at()), 40_000);
  advance(60_000);
  assert.equal(registry.activeCount(), 1, 'the teammate still gates 120s after first sighting; the shell aged out');
  assert.equal(registry.hasDeclared(), true);
  assert.equal(registry.msUntilNextDrain(at()), 30_000);
});

test('only live shell declarations qualify as background-only after teammate idle subtraction', () => {
  const { registry, advance } = makeRegistry({ teammateTaskTtlMs: 100, shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }, { id: 't1', type: 'teammate' }]);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  registry.noteTeammateIdle('alice', 1_000_000);
  assert.equal(registry.isOnlyBackgroundTasks(), true);
  registry.noteAgentStart('a1', 1_000_000);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  registry.noteAgentStop('a1');
  assert.equal(registry.isOnlyBackgroundTasks(), true);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }, { id: 'x1' }]);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  registry.noteTaskCompleted({ taskId: 'x1' });
  assert.equal(registry.isOnlyBackgroundTasks(), true);
  advance(200);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
});

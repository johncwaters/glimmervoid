import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTaskRegistry,
  extractBackgroundTasks,
  isServiceShellLaunch,
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
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  advance(100);
  assert.equal(registry.activeCount(), 1);
  assert.equal(registry.hasDeclared(), true);
  advance(100);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.hasDeclared(), false);
});

test('a re-declared shell keeps its first age across Stops and turn resets', () => {
  const { registry, advance, at } = makeRegistry({ shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  advance(100);
  registry.clearDeclared();
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  assert.equal(registry.msUntilNextDrain(at()), 100);
  advance(99);
  assert.equal(registry.activeCount(), 1);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  assert.equal(registry.msUntilNextDrain(at()), 1);
  advance(1);
  assert.equal(registry.activeCount(), 0);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.msUntilNextDrain(at()), null);
});

test('a task id omitted from a later snapshot starts a new age when it returns', () => {
  const { registry, advance } = makeRegistry({ shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  advance(150);
  registry.reconcileDeclared([], false);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }], false);
  advance(100);
  assert.equal(registry.activeCount(), 1);
});

test('a re-declared teammate ages from its latest snapshot while a re-declared shell ages from first sighting', () => {
  const { registry, advance, at } = makeRegistry({ teammateTaskTtlMs: 90_000, shellTaskTtlMs: 100_000 });
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 'b1', type: 'shell' }], false);
  advance(60_000);
  registry.reconcileDeclared([{ id: 't1', type: 'teammate' }, { id: 'b1', type: 'shell' }], false);
  assert.equal(registry.msUntilNextDrain(at()), 40_000);
  advance(60_000);
  assert.equal(registry.activeCount(), 1, 'the teammate still gates 120s after first sighting; the shell aged out');
  assert.equal(registry.hasDeclared(), true);
  assert.equal(registry.msUntilNextDrain(at()), 30_000);
});

test('only live shell declarations qualify as background-only after teammate idle subtraction', () => {
  const { registry, advance } = makeRegistry({ teammateTaskTtlMs: 100, shellTaskTtlMs: 200 });
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }, { id: 't1', type: 'teammate' }], false);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  registry.noteTeammateIdle('alice', 1_000_000);
  assert.equal(registry.isOnlyBackgroundTasks(), true);
  registry.noteAgentStart('a1', 1_000_000);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  registry.noteAgentStop('a1');
  assert.equal(registry.isOnlyBackgroundTasks(), true);
  registry.reconcileDeclared([{ id: 'b1', type: 'shell' }, { id: 'x1' }], false);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  registry.noteTaskCompleted({ taskId: 'x1' });
  assert.equal(registry.isOnlyBackgroundTasks(), true);
  advance(200);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
});

test('a service shell does not gate completion while finite shells keep gating', () => {
  assert.equal(isServiceShellLaunch({ command: 'npm run dev', description: 'Serve skills' }), true);
  assert.equal(isServiceShellLaunch({ command: 'cd /repo\nnpm run dev' }), true);
  assert.equal(isServiceShellLaunch({ command: '  npm --prefix site run dev' }), true);
  assert.equal(isServiceShellLaunch({ command: 'npm run site:dev' }), true);
  assert.equal(isServiceShellLaunch({ command: 'tsx watch server/index.ts' }), true);
  assert.equal(isServiceShellLaunch({ command: 'GATSBY_MINIMAL=true PORT=8011 pnpm start > /tmp/log' }), true);
  assert.equal(isServiceShellLaunch({ command: 'cd /repo && python3 -m http.server 8765' }), true);
  assert.equal(isServiceShellLaunch({ command: 'cd /repo && node .serve.mjs' }), true);
  assert.equal(isServiceShellLaunch({ command: 'node harness/browser/chat-view.ts', description: 'Serve chat view on port 5199' }), true);
  assert.equal(isServiceShellLaunch({ command: 'cd /repo && npx vite build > /tmp/build.log' }), false);
  assert.equal(isServiceShellLaunch({ command: 'npx vite -c vite.server.config.ts build' }), false);
  assert.equal(isServiceShellLaunch({ command: 'npm run storybook:build' }), false);
  assert.equal(isServiceShellLaunch({ command: 'jest -w 4' }), false);
  assert.equal(isServiceShellLaunch({ command: 'node scripts/build-server.mjs' }), false);
  assert.equal(isServiceShellLaunch({ command: 'node tests/server.test.ts' }), false);
  assert.equal(isServiceShellLaunch({ command: 'npm test', description: 'Run server tests' }), false);
  assert.equal(isServiceShellLaunch({ command: 'npm run build', description: 'Run server build' }), false);
  assert.equal(isServiceShellLaunch({ command: 'npm test', description: 'Wait for dev server ready' }), false);

  const { registry, advance, at } = makeRegistry({ shellTaskTtlMs: 200 });
  registry.noteBackgroundTaskLaunched('svc-1', true);
  registry.reconcileDeclared([{ id: 'svc-1', type: 'shell' }], false);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  assert.equal(registry.hasLiveMonitor(), true);
  assert.equal(registry.msUntilNextDrain(at()), null);

  registry.reconcileDeclared([], true);
  assert.equal(registry.activeCount(), 0);

  const extracted = extractBackgroundTasks({
    background_tasks: [
      { id: 'svc-2', type: 'shell', status: 'running', description: 'Start the dev server on port 8011' },
      { id: 'svc-3', type: 'shell', status: 'running', description: 'npm run dev' },
    ],
  });
  assert.ok(extracted);
  registry.reconcileDeclared(extracted, false);
  assert.equal(registry.activeCount(), 0);
  assert.equal(registry.isOnlyBackgroundTasks(), false);
  assert.equal(registry.hasLiveMonitor(), true);
  advance(200);
  assert.equal(registry.hasLiveMonitor(), false);
  assert.equal(registry.shellWorkExpiryCount(), 0);
});

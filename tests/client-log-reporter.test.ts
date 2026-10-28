import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientLogReporter } from '../public/client-error-core.ts';

test('a log line reported while the control socket is closed reaches the server once it reopens, exactly once', () => {
  let isSocketOpen = false;
  const delivered: Record<string, unknown>[] = [];
  const reporter = createClientLogReporter((message) => {
    if (!isSocketOpen) return false;
    delivered.push(message);
    return true;
  });

  reporter.report('header error', 'Add session: Session "general-projects" already exists');
  reporter.report('header error', 'Add session: Session "general-projects" already exists');
  reporter.flushUnsent();
  assert.deepEqual(delivered, []);

  isSocketOpen = true;
  reporter.flushUnsent();
  reporter.flushUnsent();
  assert.deepEqual(delivered, [{ type: 'client-log', scope: 'header error', text: 'Add session: Session "general-projects" already exists' }]);
});

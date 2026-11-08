import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from '../helpers/dashboard-ws.ts';
import { assertCleanLog, countLogLines, startServer } from './support/server-process.ts';

const SCENARIO_SEEDS = ['server/index.ts'];

interface ControlFrame {
  type: string;
}

test('the server boots, serves the control socket, and stops everything it started on SIGTERM', async (t) => {
  const server = await startServer({ scenarioName: 'boot-shutdown', testContext: t });
  const client = await dashboardClient(server.port);
  const control = await openRecordingSocket<ControlFrame>(client, '/control');
  await waitForMessage(control.received, (frame) => frame.type === 'snapshot', 'the control snapshot');
  await server.waitForLogLine(/\[watcher\] delivered probe set/, 'the watcher taking its probe set');
  assert.ok(server.descendantPids().length > 0, 'the server should be running the watcher child before the stop');
  await closeSocket(control.ws);

  const stopped = await server.stopProcessGroup('SIGTERM');
  t.diagnostic(`boot ${server.bootMs} ms, shutdown ${stopped.shutdownMs} ms`);

  assert.equal(stopped.hasMissedShutdownDeadline, false, `the server did not exit after SIGTERM:\n${server.logText()}`);
  assert.equal(stopped.exitCode, 0, `the server exited with ${stopped.exitCode} (${stopped.exitSignal}):\n${server.logText()}`);
  assert.deepEqual(stopped.descendantPidsStillRunning, [], 'processes the server started outlived it');
  assert.equal(countLogLines(server.logText(), /\[watcher\] started child pid/), 1, 'the watcher started again during shutdown');
  assertCleanLog(server.logText());
});

export { SCENARIO_SEEDS };

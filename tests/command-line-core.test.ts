import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

type CliRun = { exitCode: number; stdout: string; stderr: string };

async function withCapturingIngress(run: (runCli: (args: string[]) => Promise<CliRun>, receivedBodies: unknown[]) => Promise<void>): Promise<void> {
  const receivedBodies: unknown[] = [];
  const ingress = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      receivedBodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await listenOnLoopback(ingress);
  const previousUrl = process.env[AGENT_URL_ENV];
  const previousLog = console.log;
  const previousError = console.error;
  process.env[AGENT_URL_ENV] = `http://127.0.0.1:${boundPort(ingress)}/agent/cli-session?t=cli-token`;
  const runCli = async (args: string[]): Promise<CliRun> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    console.log = (line: unknown) => { stdout.push(String(line)); };
    console.error = (line: unknown) => { stderr.push(String(line)); };
    try {
      return { exitCode: await runAgentApiCli(args), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    } finally {
      console.log = previousLog;
      console.error = previousError;
    }
  };
  try {
    await run(runCli, receivedBodies);
  } finally {
    if (previousUrl === undefined) delete process.env[AGENT_URL_ENV];
    if (previousUrl !== undefined) process.env[AGENT_URL_ENV] = previousUrl;
    await closeServer(ingress);
  }
}

test('a flag after an agent command is parsed as a flag, never sent as a whiteboard title or prompt', async () => {
  await withCapturingIngress(async (runCli, receivedBodies) => {
    const help = await runCli(['whiteboard', 'new', '--help']);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /^Usage: glimmervoid whiteboard new <title>/);

    const unknownOption = await runCli(['whiteboard', 'new', '--foo']);
    assert.equal(unknownOption.exitCode, 1);
    assert.match(unknownOption.stderr, /unknown option --foo/);
    assert.deepEqual(receivedBodies, []);

    assert.equal((await runCli(['whiteboard', 'new', '--', '--help'])).exitCode, 0);
    assert.equal((await runCli(['spawn', 'fix the --help output'])).exitCode, 0);
    assert.deepEqual(receivedBodies, [{ sub: 'new', title: '--help' }, { prompt: 'fix the --help output' }]);
  });
});

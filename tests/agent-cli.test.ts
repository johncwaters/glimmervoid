import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const SESSION_ID = 'cli-session';
const TOKEN = 'cli-agent-token';

interface CliRun {
  code: number;
  stdout: string[];
  stderr: string[];
}

interface ReceivedRequest {
  url: string;
  authorization: string;
  body: string;
}

async function runCli(args: string[], agentUrl: string | null): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousUrl = process.env[AGENT_URL_ENV];
  const previousLog = console.log;
  const previousError = console.error;
  if (agentUrl === null) delete process.env[AGENT_URL_ENV];
  if (agentUrl !== null) process.env[AGENT_URL_ENV] = agentUrl;
  console.log = (line: unknown) => { stdout.push(String(line)); };
  console.error = (line: unknown) => { stderr.push(String(line)); };
  try {
    const code = await runAgentApiCli(args);
    return { code, stdout, stderr };
  } finally {
    console.log = previousLog;
    console.error = previousError;
    if (previousUrl == null) delete process.env[AGENT_URL_ENV];
    if (previousUrl != null) process.env[AGENT_URL_ENV] = previousUrl;
  }
}

async function withAgentServer(
  reply: (received: ReceivedRequest) => { status: number; body: string },
  run: (agentUrl: string, received: ReceivedRequest[]) => Promise<void>,
): Promise<void> {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const entry = {
        url: request.url || '',
        authorization: String(request.headers.authorization || ''),
        body,
      };
      received.push(entry);
      const answer = reply(entry);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await listenOnLoopback(server);
  const agentUrl = `http://127.0.0.1:${boundPort(server)}/agent/${SESSION_ID}?t=${TOKEN}`;
  try {
    await run(agentUrl, received);
  } finally {
    server.closeAllConnections();
    await closeServer(server);
  }
}

const OK_REPLY = () => ({ status: 200, body: '{"ok":true}' });

test('every agent verb exits non-zero with one line when the session env is absent', async () => {
  for (const args of [['spawn', 'go'], ['attention', 'look'], ['board']]) {
    const run = await runCli(args, null);
    assert.equal(run.code, 1, args[0]);
    assert.equal(run.stderr.length, 1, `${args[0]} says it once`);
    assert.match(run.stderr[0], new RegExp(AGENT_URL_ENV));
  }
});

test('a name that is not an agent verb never reaches the network', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    const run = await runCli(['kill', 'the-session'], agentUrl);
    assert.equal(run.code, 1);
    assert.equal(received.length, 0);
  });
});

test('spawn posts the joined prompt to the spawn verb with the url token as a bearer', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    const run = await runCli(['spawn', 'review', 'the', 'diff'], agentUrl);
    assert.equal(run.code, 0, run.stderr.join('\n'));
    assert.equal(received.length, 1);
    assert.equal(received[0].url, `/agent/${SESSION_ID}/spawn`);
    assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(received[0].body), { prompt: 'review the diff' });
    assert.deepEqual(run.stdout, ['{"ok":true}']);
  });
});

test('attention posts the joined note and board posts an empty object', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    await runCli(['attention', 'pick', 'a', 'base', 'branch'], agentUrl);
    await runCli(['board'], agentUrl);
    assert.equal(received.length, 2);
    assert.equal(received[0].url, `/agent/${SESSION_ID}/attention`);
    assert.deepEqual(JSON.parse(received[0].body), { note: 'pick a base branch' });
    assert.equal(received[1].url, `/agent/${SESSION_ID}/board`);
    assert.deepEqual(JSON.parse(received[1].body), {});
  });
});

test('the token never rides the query string of the posted url', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    await runCli(['board'], agentUrl);
    assert.equal(received[0].url.includes(TOKEN), false);
    assert.equal(received[0].url.includes('?'), false);
  });
});

test('a refusal is printed and exits non-zero', async () => {
  await withAgentServer(() => ({ status: 404, body: '{"ok":false,"error":"unknown session"}' }), async (agentUrl) => {
    const run = await runCli(['board'], agentUrl);
    assert.equal(run.code, 1);
    assert.match(run.stdout.join('\n'), /unknown session/);
  });
});

test('a 200 that is not ok still exits non-zero', async () => {
  await withAgentServer(() => ({ status: 200, body: '{"ok":false}' }), async (agentUrl) => {
    const run = await runCli(['board'], agentUrl);
    assert.equal(run.code, 1);
  });
});

test('a url that is not the loopback agent ingress is refused before the token can travel', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    const port = new URL(agentUrl).port;
    const rejected = [
      `http://glimmervoid.example.com:${port}/agent/${SESSION_ID}?t=${TOKEN}`,
      `https://127.0.0.1:${port}/agent/${SESSION_ID}?t=${TOKEN}`,
      `http://127.0.0.1:${port}/upload/${SESSION_ID}?t=${TOKEN}`,
      'not a url',
    ];
    for (const url of rejected) {
      const run = await runCli(['board'], url);
      assert.equal(run.code, 1, url);
      assert.equal(run.stderr.length, 1, url);
      assert.equal(run.stderr[0].includes(TOKEN), false, url);
      assert.deepEqual(run.stdout, [], url);
    }
    assert.equal(received.length, 0, 'nothing was posted anywhere');
  });
});

test('a verb with no text exits non-zero without reaching the server', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    const run = await runCli(['attention'], agentUrl);
    assert.equal(run.code, 1);
    assert.equal(received.length, 0);
  });
});

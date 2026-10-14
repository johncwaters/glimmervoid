import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { runAgentApiCli, sessionLimitsHelpLines } from '../server/agent-api-cli.ts';
import { AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { boundPort, closeServer, listenOnLoopback, reserveFreePort } from './helpers/http-server.ts';

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

const SANDBOX_ENVIRONMENT_NAMES = ['SANDBOX_RUNTIME', 'HTTP_PROXY', 'http_proxy'];
const CLI_ENTRY = path.join(import.meta.dirname, '..', 'bin', 'glimmervoid.ts');
const LIMITS_UNKNOWN_LINE = 'This session: Glimmervoid did not report its limits, so run glimmervoid limits to see why';
const LIMITS_REPLY = JSON.stringify({
  ok: true,
  commands: [{ name: 'push', answers: true }, { name: 'spawn', answers: false, reason: 'a spawned session may not spawn another' }],
  sandboxed: true,
  deadEnds: [{ blocked: 'credential folders are off limits', route: 'flag the operator with glimmervoid attention' }],
});
const LIMITS_LINES = [
  'This session:',
  '  push: available',
  '  spawn: not available, a spawned session may not spawn another',
  '  guardrails: OS-enforced, so a read, write or connection they refuse will not succeed on retry',
  '  credential folders are off limits: flag the operator with glimmervoid attention',
];

async function helpOutput(agentUrl: string | null): Promise<string[]> {
  const { [AGENT_URL_ENV]: _sessionAgentUrl, ...environmentOutsideAnySession } = process.env;
  const environment = agentUrl === null ? environmentOutsideAnySession : { ...environmentOutsideAnySession, [AGENT_URL_ENV]: agentUrl };
  const { stdout } = await promisify(execFile)(process.execPath, [CLI_ENTRY, '--help'], { encoding: 'utf8', env: environment });
  return stdout.trimEnd().split('\n');
}

function setEnvironmentValue(name: string, value: string | null | undefined): void {
  if (value == null) delete process.env[name];
  if (value != null) process.env[name] = value;
}

async function inSessionEnvironment<Outcome>(agentUrl: string | null, sandboxEnvironment: Record<string, string>, run: () => Promise<Outcome>): Promise<Outcome> {
  const controlledNames = [AGENT_URL_ENV, ...SANDBOX_ENVIRONMENT_NAMES];
  const previousValues = controlledNames.map((name) => [name, process.env[name]] as const);
  setEnvironmentValue(AGENT_URL_ENV, agentUrl);
  for (const name of SANDBOX_ENVIRONMENT_NAMES) setEnvironmentValue(name, sandboxEnvironment[name]);
  try {
    return await run();
  } finally {
    for (const [name, previousValue] of previousValues) setEnvironmentValue(name, previousValue);
  }
}

async function runCli(args: string[], agentUrl: string | null, sandboxEnvironment: Record<string, string> = {}): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (line: unknown) => { stdout.push(String(line)); };
  console.error = (line: unknown) => { stderr.push(String(line)); };
  try {
    const code = await inSessionEnvironment(agentUrl, sandboxEnvironment, () => runAgentApiCli(args));
    return { code, stdout, stderr };
  } finally {
    console.log = previousLog;
    console.error = previousError;
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
  for (const args of [['spawn', 'go'], ['attention', 'look'], ['board'], ['dispatch', 'wrk-0123456789abcdef']]) {
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

test('limits prints the session limits as lines, and a reply it cannot read as it came', async () => {
  await withAgentServer(() => ({ status: 200, body: LIMITS_REPLY }), async (agentUrl, received) => {
    const run = await runCli(['limits'], agentUrl);
    assert.equal(run.code, 0);
    assert.equal(received[0].url, `/agent/${SESSION_ID}/limits`);
    assert.deepEqual(run.stdout.join('\n').split('\n'), LIMITS_LINES);
  });
  const refusal = '{"ok":false,"reason":"only live factory orchestrators may dispatch, reopen or cancel, and they may do nothing else"}';
  await withAgentServer(() => ({ status: 403, body: refusal }), async (agentUrl) => {
    const run = await runCli(['limits'], agentUrl);
    assert.deepEqual([run.code, run.stdout], [1, [refusal]]);
  });
});

test('--help in a session ends with its limits, or with one line when the server does not answer', async () => {
  const staticHelp = await helpOutput(null);
  assert.equal(staticHelp[0], 'Usage: glimmervoid [command] [options]');
  await withAgentServer(() => ({ status: 200, body: LIMITS_REPLY }), async (agentUrl, received) => {
    assert.deepEqual(await helpOutput(agentUrl), [...staticHelp, '', ...LIMITS_LINES]);
    assert.deepEqual(received.map(({ url, authorization }) => [url, authorization]), [[`/agent/${SESSION_ID}/limits`, `Bearer ${TOKEN}`]]);
  });
  const deadAgentUrl = `http://127.0.0.1:${await reserveFreePort()}/agent/${SESSION_ID}?t=${TOKEN}`;
  assert.deepEqual(await helpOutput(deadAgentUrl), [...staticHelp, '', LIMITS_UNKNOWN_LINE]);
});

test('one deadline covers the direct post and the sandbox proxy retry behind --help', async () => {
  const agentUrl = `http://127.0.0.1:${await reserveFreePort()}/agent/${SESSION_ID}?t=${TOKEN}`;
  let proxiedRequests = 0;
  const silentProxy = http.createServer(() => { proxiedRequests += 1; });
  await listenOnLoopback(silentProxy);
  const sandboxEnvironment = { SANDBOX_RUNTIME: '1', HTTP_PROXY: `http://127.0.0.1:${boundPort(silentProxy)}` };
  try {
    const helpLines = await inSessionEnvironment(agentUrl, sandboxEnvironment, () => sessionLimitsHelpLines({ timeoutMs: 150 }));
    assert.deepEqual(helpLines, [LIMITS_UNKNOWN_LINE]);
    assert.equal(proxiedRequests, 1, 'the retry reached the proxy and was cut off there');
  } finally {
    silentProxy.closeAllConnections();
    await closeServer(silentProxy);
  }
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


test('dispatch posts only the validated first work id with its bearer token', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    const run = await runCli(['dispatch', 'wrk-0123456789abcdef', 'ignored'], agentUrl);
    assert.equal(run.code, 0);
    assert.deepEqual(JSON.parse(received[0].body), { workId: 'wrk-0123456789abcdef' });
    assert.equal(received[0].url, `/agent/${SESSION_ID}/dispatch`);
    assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
    for (const workId of ['', 'wrk-0123456789abcdeg', 'wrk-0123456789abcdefextra', 'wrk-0123456789ABCDEF', '--help']) {
      assert.equal((await runCli(['dispatch', workId], agentUrl)).code, 1);
    }
    assert.equal(received.length, 1);
  });
});

test('dispatch ready posts the validated intent to the authenticated dispatch verb', async () => {
  await withAgentServer(OK_REPLY, async (agentUrl, received) => {
    const cliRun = await runCli(['dispatch', '--ready', 'wrk-0123456789abcdef'], agentUrl);
    assert.equal(cliRun.code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, `/agent/${SESSION_ID}/dispatch`);
    assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(received[0].body), { readyIntent: 'wrk-0123456789abcdef' });
    for (const intentId of ['', 'not-an-intent', 'wrk-0123456789ABCDEF']) {
      assert.equal((await runCli(['dispatch', '--ready', intentId], agentUrl)).code, 1);
    }
    assert.equal(received.length, 1);
  });
});

test('inside the session sandbox a refused loopback post goes through the sandbox proxy, and through no other proxy', async () => {
  const agentUrl = `http://127.0.0.1:${await reserveFreePort()}/agent/${SESSION_ID}?t=${TOKEN}`;
  const proxied: { url: string; authorization: string; proxyAuthorization: string; body: string }[] = [];
  const proxy = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      proxied.push({ url: request.url || '', authorization: String(request.headers.authorization || ''), proxyAuthorization: String(request.headers['proxy-authorization'] || ''), body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await listenOnLoopback(proxy);
  const sandboxProxyUrl = `http://sandbox%3Dname:secret@127.0.0.1:${boundPort(proxy)}`;
  try {
    const sandboxed = await runCli(['dispatch', 'wrk-0123456789abcdef'], agentUrl, { SANDBOX_RUNTIME: '1', HTTP_PROXY: sandboxProxyUrl });
    assert.equal(sandboxed.code, 0, sandboxed.stderr.join('\n'));
    assert.deepEqual(proxied, [{
      url: `${new URL(agentUrl).origin}/agent/${SESSION_ID}/dispatch`,
      authorization: `Bearer ${TOKEN}`,
      proxyAuthorization: `Basic ${Buffer.from('sandbox=name:secret').toString('base64')}`,
      body: '{"workId":"wrk-0123456789abcdef"}',
    }]);

    const proxiesThatMustStayUnused: Record<string, string>[] = [
      { HTTP_PROXY: sandboxProxyUrl },
      { SANDBOX_RUNTIME: '1', HTTP_PROXY: `http://proxy.example.com:${boundPort(proxy)}` },
      { SANDBOX_RUNTIME: '1', HTTP_PROXY: `https://127.0.0.1:${boundPort(proxy)}` },
      { SANDBOX_RUNTIME: '1', HTTP_PROXY: `http://u%:p@127.0.0.1:${boundPort(proxy)}` },
    ];
    for (const environment of proxiesThatMustStayUnused) {
      await assert.rejects(runCli(['board'], agentUrl, environment), /fetch failed/, JSON.stringify(environment));
    }
    assert.equal(proxied.length, 1, 'the token travelled only through the loopback sandbox proxy');
  } finally {
    proxy.closeAllConnections();
    await closeServer(proxy);
  }
});

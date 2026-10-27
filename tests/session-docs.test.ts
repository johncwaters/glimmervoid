import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { AGENT_URL_ENV, SESSION_DOC_BODY_CAP_BYTES } from '../shared/contracts/session.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const SESSION_ID = 'docs-session';
const TOKEN = 'docs-agent-token';

type Frame = Record<string, unknown>;

async function docsFixture(run: (fixture: {
  checkout: string;
  outside: string;
  broadcasts: Frame[];
  edit: (docPath: string) => Promise<{ code: number; output: string }>;
  control: { sent: Frame[]; request: (message: Frame) => Promise<Frame> };
}) => Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-docs-'));
  const checkout = path.join(tmpDir, 'checkout');
  const outside = path.join(tmpDir, 'outside');
  fs.mkdirSync(checkout);
  fs.mkdirSync(outside);
  const session = new Session({ id: SESSION_ID, name: 'docs', path: checkout, ptySpawn: () => fakePty() });
  const broadcasts: Frame[] = [];
  const sessionDocs = createSessionDocsWiring({ broadcastControl: (message) => { broadcasts.push(message); } });
  const config = { ...DEFAULT_CONFIG, agentApi: { enabled: true }, projects: [] };
  const agentApi = createAgentApiWiring({
    config,
    agentSessions: new Map(),
    listAllSessions: () => [session],
    listBoardSessions: () => [session],
    makeSession: () => { throw new Error('no spawns here'); },
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    broadcastControl: () => {},
    spawnGate: { run: (task: () => unknown) => Promise.resolve(task()) },
    sessionDocs,
    logger: { warn: () => {} },
  });
  const ingress = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', async () => {
      const verb = String(request.url).split('/').pop() || '';
      const reply = await agentApi.handle(session, verb, JSON.parse(body));
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await listenOnLoopback(ingress);
  const controlServer = createControlServer(controlDeps(config, { sessions: new Map([[SESSION_ID, session]]), sessionDocs }));
  const connection = connectControl<Frame>(controlServer);
  const edit = async (docPath: string) => {
    const output: string[] = [];
    const previousLog = console.log;
    const previousError = console.error;
    const previousUrl = process.env[AGENT_URL_ENV];
    const previousCwd = process.cwd();
    process.env[AGENT_URL_ENV] = `http://127.0.0.1:${boundPort(ingress)}/agent/${SESSION_ID}?t=${TOKEN}`;
    console.log = (line: unknown) => { output.push(String(line)); };
    console.error = (line: unknown) => { output.push(String(line)); };
    process.chdir(checkout);
    try {
      const code = await runAgentApiCli(['edit', docPath]);
      return { code, output: output.join('\n') };
    } finally {
      process.chdir(previousCwd);
      console.log = previousLog;
      console.error = previousError;
      if (previousUrl == null) delete process.env[AGENT_URL_ENV];
      if (previousUrl != null) process.env[AGENT_URL_ENV] = previousUrl;
    }
  };
  const request = async (message: Frame) => {
    const before = connection.sent.length;
    await connection.send(message);
    return connection.sent[before];
  };
  try {
    await run({ checkout, outside, broadcasts, edit, control: { sent: connection.sent, request } });
  } finally {
    session.destroy();
    ingress.closeAllConnections();
    await closeServer(ingress);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('an agent surfaces a draft, the operator saves an edit over the control socket, and the agent reads it back with its line endings intact', async () => {
  await docsFixture(async ({ checkout, broadcasts, edit, control }) => {
    const draftPath = path.join(checkout, 'drafts', 'post.md');
    fs.mkdirSync(path.dirname(draftPath));
    fs.writeFileSync(draftPath, '# Title\r\nfirst draft\r\n');
    fs.chmodSync(draftPath, 0o640);

    const surfaced = await edit('drafts/post.md');
    assert.equal(surfaced.code, 0, surfaced.output);
    const realDraftPath = fs.realpathSync(draftPath);
    assert.deepEqual(broadcasts.map((frame) => [frame.type, frame.id]), [['session-docs-changed', SESSION_ID]]);
    const [listed] = broadcasts[0].docs as Frame[];
    assert.deepEqual([listed.path, listed.name], [realDraftPath, path.join('drafts', 'post.md')]);

    const opened = await control.request({ type: 'session-doc-read', requestId: 'r1', id: SESSION_ID, path: realDraftPath });
    assert.deepEqual([opened.type, opened.requestId, opened.ok, opened.text], ['session-doc-response', 'r1', true, '# Title\nfirst draft\n']);

    const saved = await control.request({ type: 'session-doc-save', requestId: 's1', id: SESSION_ID, path: realDraftPath, text: '# Title\nsecond draft\n', baseHash: opened.hash });
    assert.deepEqual([saved.type, saved.requestId, saved.ok], ['session-doc-save-result', 's1', true], String(saved.error));
    assert.equal(fs.readFileSync(draftPath, 'utf8'), '# Title\r\nsecond draft\r\n');
    assert.equal(fs.statSync(draftPath).mode & 0o777, 0o640);

    const reopened = await control.request({ type: 'session-doc-read', requestId: 'r2', id: SESSION_ID, path: realDraftPath });
    assert.equal(reopened.hash, saved.hash, 'the saved hash is the hash a later save must present');
  });
});

test('a save after the agent changed the file is refused as a conflict and leaves the agent bytes on disk', async () => {
  await docsFixture(async ({ checkout, edit, control }) => {
    const draftPath = path.join(checkout, 'post.md');
    fs.writeFileSync(draftPath, 'operator opened this\n');
    assert.equal((await edit('post.md')).code, 0);
    const realDraftPath = fs.realpathSync(draftPath);
    const opened = await control.request({ type: 'session-doc-read', requestId: 'r1', id: SESSION_ID, path: realDraftPath });

    fs.writeFileSync(draftPath, 'agent rewrote this\n');
    const saved = await control.request({ type: 'session-doc-save', requestId: 's1', id: SESSION_ID, path: realDraftPath, text: 'operator text\n', baseHash: opened.hash });
    assert.deepEqual([saved.ok, saved.conflict], [false, true]);
    assert.equal(fs.readFileSync(draftPath, 'utf8'), 'agent rewrote this\n');
  });
});

test('the CLI refuses a path outside the checkout, a symlink escape, a missing, binary or oversize file, and the browser cannot name an unsurfaced file', async () => {
  await docsFixture(async ({ checkout, outside, broadcasts, edit, control }) => {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'not yours\n');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(checkout, 'escape.md'));
    fs.writeFileSync(path.join(checkout, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    fs.writeFileSync(path.join(checkout, 'huge.md'), 'x'.repeat(SESSION_DOC_BODY_CAP_BYTES + 1));
    fs.writeFileSync(path.join(checkout, 'sparse.md'), '');
    fs.linkSync(path.join(outside, 'secret.md'), path.join(checkout, 'linked.md'));
    fs.truncateSync(path.join(checkout, 'sparse.md'), 3 * 1024 ** 3);

    const refusals = [
      ['../outside/secret.md', /outside this session's checkout/],
      ['escape.md', /outside this session's checkout/],
      ['missing.md', /no file exists/],
      ['image.bin', /not UTF-8 text/],
      ['huge.md', /over 256 KiB/],
      ['sparse.md', /over 256 KiB/],
      ['linked.md', /other hard links/],
    ] as const;
    for (const [docPath, reason] of refusals) {
      const refused = await edit(docPath);
      assert.equal(refused.code, 1, docPath);
      assert.match(refused.output, reason, docPath);
    }
    assert.equal(broadcasts.length, 0);

    const probe = await control.request({ type: 'session-doc-read', requestId: 'r1', id: SESSION_ID, path: path.join(outside, 'secret.md') });
    assert.deepEqual([probe.ok, probe.text], [false, undefined]);
    const overwrite = await control.request({ type: 'session-doc-save', requestId: 's1', id: SESSION_ID, path: path.join(outside, 'secret.md'), text: 'owned', baseHash: 'x' });
    assert.equal(overwrite.ok, false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'not yours\n');
  });
});

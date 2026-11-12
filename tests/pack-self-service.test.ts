import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import { readPacksForAgent } from '../server/packs/pack-agent.ts';
import { PACKS_DIR_NAME, packsStatePath } from '../server/packs/pack-files.ts';
import { createPackLaunchers } from '../server/packs/launchers.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../server/spawn-gate.ts';
import { memoryReserveBytes } from '../server/core/memory-admission-core.ts';
import { Session } from '../session/sessions.ts';
import { TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { waitFor } from './helpers/wait-for.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const EXAMPLE_THEME_PACK = path.resolve('examples/packs/night-shift');

function idleSession(projectPath: string): Session {
  const session = new Session({ id: 'pack-author', name: 'pack-author', path: projectPath, ptySpawn: () => fakePty() });
  session.transition('user_start');
  session.transition('spawn_success', { spawnCwdExists: true });
  session.transition('first_output');
  return session;
}

function selfServiceFixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-self-service-'));
  const projectDir = path.join(homeDir, 'project');
  fs.cpSync(EXAMPLE_THEME_PACK, path.join(projectDir, 'my-pack'), { recursive: true });
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, agentApi: { enabled: true }, projects: [] };
  const session = idleSession(projectDir);
  const wiring = createAgentApiWiring({
    config,
    agentSessions: new Map(),
    listAllSessions: () => [session],
    listBoardSessions: () => [session],
    makeSession: () => { throw new Error('no spawns here'); },
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    broadcastControl: () => {},
    spawnGate: createSpawnGate({ memoryAdmission: createMemoryAdmission({ readHeadroom: async () => ({ ok: true as const, headroomBytes: 64 * 1024 ** 3 }), reserveBytesFor: (kind) => memoryReserveBytes(config, kind), warn: () => {} }) }),
    sessionDocs: createSessionDocsWiring({ broadcastControl: () => {} }),
    operatorState: {
      requestReview: async () => ({ ok: false as const, error: 'not in this fixture' }),
      teamReviewStatus: () => TeamReviewStatus.parse({ type: 'team-review-status', ts: 0, configured: false, drafts: [], inFlight: [] }),
      myPrsStatus: () => null,
      readSettings: () => ({ ok: false as const, error: 'not in this fixture' }),
      readPacks: (request) => readPacksForAgent(request, {
        homeDir, env: process.env, examplePacksDir: path.resolve('examples/packs'),
        packRows: () => packStore.statusFrame().packs, isApproved: (fingerprint) => packStore.isApproved(fingerprint),
      }),
    },
    logger: { warn: () => {} },
  });
  const packs = async (request: Record<string, unknown>) => {
    const reply = await wiring.handle(session, 'packs', request);
    return { status: reply.status, body: reply.body as { ok: boolean; text?: string; error?: string; hasProblem?: boolean } };
  };
  const rowNamed = (name: string) => packStore.statusFrame().packs.find((row) => row.name === name);
  const cleanUp = () => {
    packStore.stop();
    session.destroy();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };
  return { homeDir, projectDir, packStore, session, packs, rowNamed, cleanUp };
}

test('an agent installs a pack, asks for approval and removes it, while only the operator approval and no agent command approves it', async () => {
  const fixture = selfServiceFixture();
  try {
    await fixture.packStore.start();
    const installed = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.equal(installed.status, 200);
    assert.equal(installed.body.hasProblem, false, installed.body.text ?? '');
    const installedDir = path.join(fixture.homeDir, PACKS_DIR_NAME, 'night-shift');
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'pending');

    const operatorNotes: string[] = [];
    fixture.session.on('agent-attention', ({ note }: { note: string }) => { operatorNotes.push(note); });
    const asked = await fixture.packs({ command: 'request-approval', name: 'night-shift' });
    assert.equal(asked.status, 200, asked.body.error ?? '');
    assert.equal(fixture.session.toSnapshot().pendingPromptKind, 'agent');
    assert.match(operatorNotes.join('\n'), /night-shift.*Settings, Packs.*2 themes/);

    for (const command of ['approve', 'pack-approve']) {
      const refused = await fixture.packs({ command, name: 'night-shift' });
      assert.equal(refused.status, 400, `${command} is no packs command`);
    }
    for (const command of ['status', 'request-approval', 'list']) await fixture.packs({ command, name: 'night-shift' });
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending', 'no agent command approved the pack');

    const pendingFingerprint = fixture.rowNamed('night-shift')?.fingerprint ?? '';
    assert.deepEqual(await fixture.packStore.approve(pendingFingerprint), { ok: true });
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'approved');

    const manifestPath = path.join(fixture.projectDir, 'my-pack', 'pack.json');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"version": 1', '"version": 2'));
    const replaced = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.match(replaced.body.text ?? '', /^Replaced night-shift/);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 2);
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending', 'a changed file asks the operator again');

    fs.rmSync(installedDir, { recursive: true });
    fs.cpSync(path.join(fixture.projectDir, 'my-pack'), installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'operator-notes.txt'), 'mine');
    const handReplaced = await fixture.packs({ command: 'remove', name: 'night-shift' });
    assert.equal(handReplaced.body.hasProblem, true, 'a folder the operator replaced by hand is not the installed copy');
    assert.equal(fs.existsSync(path.join(installedDir, 'operator-notes.txt')), true);
    fs.rmSync(path.join(installedDir, 'operator-notes.txt'));

    const reinstalled = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.equal(reinstalled.body.hasProblem, true, 'the dropped install record leaves the hand-placed folder alone');
    fs.rmSync(installedDir, { recursive: true });
    await fixture.packs({ command: 'install', path: 'my-pack' });
    const removed = await fixture.packs({ command: 'remove', name: 'night-shift' });
    assert.equal(removed.body.hasProblem, false, removed.body.text ?? '');
    assert.equal(fs.existsSync(installedDir), false);
    await waitFor(() => fixture.rowNamed('night-shift') === undefined);
  } finally {
    fixture.cleanUp();
  }
});

test('packs remove and install leave a hand-placed pack alone, and install refuses a folder failing check', async () => {
  const fixture = selfServiceFixture();
  try {
    const handPlacedDir = path.join(fixture.homeDir, PACKS_DIR_NAME, 'night-shift');
    fs.cpSync(EXAMPLE_THEME_PACK, handPlacedDir, { recursive: true });
    await fixture.packStore.start();
    await waitFor(() => fixture.rowNamed('night-shift') !== undefined);

    const removed = await fixture.packs({ command: 'remove', name: 'night-shift' });
    assert.equal(removed.body.hasProblem, true);
    assert.equal(fs.existsSync(path.join(handPlacedDir, 'pack.json')), true);

    const clashing = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.equal(clashing.body.hasProblem, true);
    assert.match(clashing.body.text ?? '', /placed or changed by hand/);

    fs.writeFileSync(path.join(fixture.projectDir, 'my-pack', 'pack.json'), '{ not json');
    const broken = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.equal(broken.body.hasProblem, true);
    assert.match(broken.body.text ?? '', /^Not installed/);
  } finally {
    fixture.cleanUp();
  }
});

test('an approved pack launcher starts a session in its project with the pack model and permission settings, and a repository with no matching project stays disabled', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-launchers-'));
  const projectDir = path.join(homeDir, 'nightly-project');
  fs.mkdirSync(projectDir);
  const packDir = path.join(homeDir, PACKS_DIR_NAME, 'nightly');
  fs.mkdirSync(packDir, { recursive: true });
  const prompt = 'Run the nightly checks\nand write up what failed.';
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
    name: 'nightly', version: 1,
    launchers: [
      { id: 'checks', label: 'Nightly checks', project: projectDir, agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', prompt },
      { id: 'elsewhere', label: 'Elsewhere', project: 'example-org/not-cloned', agent: 'claude-code', prompt: 'Hello' },
    ],
    sessions: { dangerouslySkipPermissions: true, saneYolo: false },
  }));
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  const clonedDir = path.join(homeDir, 'cloned-later');
  const projectPaths = [projectDir];
  const packLaunchers = createPackLaunchers({
    packStore, projectPaths: () => projectPaths, originUrl: async (projectPath) => (projectPath === clonedDir ? 'git@github.com:example-org/not-cloned.git' : 'git@github.com:example-org/other.git'),
    operatorSaneYolo: () => true, onResolved: () => {}, log: { warn: () => {} },
  });
  const config: GlimmervoidConfig = { projects: [] };
  const connection = connectControl<{ requestId?: string; ok?: boolean; error?: string | null }>(createControlServer(controlDeps(config, { packLaunchers, generateProjectId: () => `launched-${config.projects.length}` })));
  const launch = (launcherId: string, requestId: string) => {
    connection.send({ type: 'pack-launch', requestId, pack: 'nightly', launcherId });
    return waitFor(() => connection.sent.some((frame) => frame.requestId === requestId)).then(() => connection.sent.find((frame) => frame.requestId === requestId));
  };
  try {
    await packStore.start();
    await waitFor(() => packStore.statusFrame().packs.some((row) => row.name === 'nightly'));
    const pendingRow = packStore.statusFrame().packs.find((row) => row.name === 'nightly');
    assert.deepEqual(pendingRow?.launchers.map((launcher) => launcher.prompt), [prompt, 'Hello'], 'the approval screen gets each prompt word for word');
    await packLaunchers.refresh();
    assert.deepEqual(packStore.statusFrame().launchers, [], 'an unapproved pack offers no launcher');
    assert.equal((await launch('checks', 'before-approval'))?.ok, false);
    assert.equal(config.projects.length, 0);

    assert.deepEqual(await packStore.approve(pendingRow?.fingerprint ?? ''), { ok: true });
    await packLaunchers.refresh();
    const [checks, elsewhere] = packStore.statusFrame().launchers;
    assert.equal(checks?.disabledReason, null);
    assert.match(elsewhere?.disabledReason ?? '', /example-org\/not-cloned/);
    assert.equal((await launch('elsewhere', 'unmatched'))?.ok, false);

    const started = await launch('checks', 'checks');
    assert.equal(started?.ok, true, started?.error ?? '');
    const [project] = config.projects;
    assert.equal(project?.name, 'Nightly checks');
    assert.equal(project?.path, projectDir);
    assert.equal(project?.agent, 'codex');
    assert.equal(project?.dangerouslySkipPermissions, true);
    assert.notEqual(project?.saneYolo, true, 'the pack turned Sane YOLO off');
    assert.equal(project?.agentSetup?.model, 'gpt-6.1-sol');
    assert.deepEqual(project?.agentSetup?.options, [{ id: 'effort', value: 'low' }]);

    fs.mkdirSync(path.join(clonedDir, '.git'), { recursive: true });
    projectPaths.push(clonedDir);
    const afterClone = await launch('elsewhere', 'after-clone');
    assert.equal(afterClone?.ok, true, afterClone?.error ?? '');
    assert.equal(config.projects.find((added) => added.name === 'Elsewhere')?.path, clonedDir);
  } finally {
    packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

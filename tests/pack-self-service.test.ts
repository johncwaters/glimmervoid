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
import { PACKS_DIR_NAME, packLauncherRunsPath, packsStatePath } from '../server/packs/pack-files.ts';
import { createPackLaunchers } from '../server/packs/launchers.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import express from 'express';
import http from 'node:http';
import { createBoardPackPreviews, mountPackPreviewRoutes } from '../server/packs/pack-preview-server.ts';
import { createPackSources, EXAMPLES_SOURCE_SLUG } from '../server/packs/pack-sources.ts';
import { runGit } from '../server/git/git-exec.ts';
import { createGithubStatus, createProviderStatus } from '../server/github/github-status.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../server/spawn-gate.ts';
import { memoryReserveBytes } from '../server/core/memory-admission-core.ts';
import { Session } from '../session/sessions.ts';
import { TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { waitFor } from './helpers/wait-for.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const EXAMPLE_THEME_PACK = path.resolve('examples/packs/night-shift');
const TEST_GIT_HOST = 'https://example.test/';

function gitServedFrom(remotesDir: string): typeof runGit {
  return (args, options) => runGit(['-c', 'protocol.file.allow=always', ...args.map((arg) => (arg.startsWith(TEST_GIT_HOST) ? `file://${path.join(remotesDir, arg.slice(TEST_GIT_HOST.length))}` : arg))], options);
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  const identity = ['-c', 'user.name=Pack Author', '-c', 'user.email=author@example.test', '-c', 'commit.gpgsign=false'];
  for (const args of [['add', '-A'], [...identity, 'commit', '-q', '-m', message]]) {
    const ran = await runGit(args, { cwd: repoDir });
    assert.ok(ran.ok, ran.err);
  }
}

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
  const bundledExamplesDir = path.join(homeDir, 'bundled-examples');
  fs.cpSync(EXAMPLE_THEME_PACK, path.join(bundledExamplesDir, 'night-shift'), { recursive: true });
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, agentApi: { enabled: true }, projects: [] };
  const session = idleSession(projectDir);
  const boardPackPreviews = createBoardPackPreviews({ env: process.env, homeDir, pagesDir: path.join(homeDir, 'pack-previews') });
  const shownOnBoard: Array<{ callerId: string; request: unknown }> = [];
  const newPackSources = (examplesRewatchMs?: number) => createPackSources({
    homeDir, env: process.env, examplePacksDir: bundledExamplesDir, log: { warn: () => {} }, examplesRewatchMs,
    packRows: () => packStore.statusFrame().packs, isApproved: (fingerprint) => packStore.isApproved(fingerprint),
    onChange: () => {}, runGitFn: gitServedFrom(path.join(homeDir, 'remotes')),
  });
  const packSources = newPackSources();
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
        packRows: () => packStore.statusFrame().packs, isApproved: (fingerprint) => packStore.isApproved(fingerprint), dashboardPort: () => 5173,
        isRequestDismissed: (packName) => packStore.isRequestDismissed(packName), reopenRequest: (packName) => packStore.reopenRequest(packName), sources: packSources,
      }),
      previewPackPage: (packDir) => boardPackPreviews.pageFor(packDir, path.basename(packDir)),
    },
    whiteboards: {
      handleAgent: async (caller, request) => {
        shownOnBoard.push({ callerId: caller.id, request });
        const board = { id: 'board-1', title: 'Packs', version: 1, updatedAt: 0, project: null, isArchived: false, connectedSessionIds: [], queuedBySessionId: {}, link: null };
        return { status: 200, body: { ok: true as const, board, note: 'showed the page as box b1 on board "Packs"' } };
      },
    },
    logger: { warn: () => {} },
  });
  const packs = async (request: Record<string, unknown>) => {
    const reply = await wiring.handle(session, 'packs', request);
    return { status: reply.status, body: reply.body as { ok: boolean; text?: string; error?: string; hasProblem?: boolean } };
  };
  const rowNamed = (name: string) => packStore.statusFrame().packs.find((row) => row.name === name);
  const cleanUp = () => {
    packSources.stop();
    packStore.stop();
    session.destroy();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };
  return { homeDir, projectDir, bundledExamplesDir, packStore, packSources, newPackSources, session, packs, rowNamed, shownOnBoard, cleanUp };
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
    assert.match(operatorNotes.join('\n'), /night-shift.*http:\/\/localhost:5173\/#pack\/night-shift .*the Packs tab.*2 themes/);
    assert.match(asked.body.text ?? '', /http:\/\/localhost:5173\/#pack\/night-shift /, 'the agent sees the link it prints for the operator');

    fixture.packStore.dismissRequest('night-shift');
    const statusAfterDismiss = await fixture.packs({ command: 'status', name: 'night-shift' });
    assert.match(statusAfterDismiss.body.text ?? '', /operator dismissed your request/);
    await fixture.packs({ command: 'request-approval', name: 'night-shift' });
    const statusAfterAskingAgain = await fixture.packs({ command: 'status', name: 'night-shift' });
    assert.doesNotMatch(statusAfterAskingAgain.body.text ?? '', /dismissed/, 'asking again clears the dismissal');

    for (const command of ['approve', 'pack-approve']) {
      const refused = await fixture.packs({ command, name: 'night-shift' });
      assert.equal(refused.status, 400, `${command} is no packs command`);
    }
    for (const command of ['status', 'request-approval', 'list']) await fixture.packs({ command, name: 'night-shift' });
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending', 'no agent command approved the pack');

    fixture.packStore.dismissRequest('night-shift');
    const pendingFingerprint = fixture.rowNamed('night-shift')?.fingerprint ?? '';
    assert.deepEqual(await fixture.packStore.approve(pendingFingerprint), { ok: true });
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'approved');

    const manifestPath = path.join(fixture.projectDir, 'my-pack', 'pack.json');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"version": 1', '"version": 2'));
    const replaced = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.match(replaced.body.text ?? '', /^Replaced night-shift/);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 2);
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending', 'a changed file asks the operator again');
    const statusOfChangedPack = await fixture.packs({ command: 'status', name: 'night-shift' });
    assert.doesNotMatch(statusOfChangedPack.body.text ?? '', /dismissed/, 'a dismissal covers only the files the operator dismissed');

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

test('packs remove and install leave a hand-placed pack alone for the operator to remove, and install refuses a folder failing check', async () => {
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

    assert.equal(fixture.rowNamed('night-shift')?.isPlacedByHand, true);
    const outside = await fixture.packSources.removeHandPlacedFolder(path.join(fixture.projectDir, 'my-pack'));
    assert.equal(outside.ok, false);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, 'my-pack', 'pack.json')), true);
    const removedByOperator = await fixture.packSources.removeHandPlacedFolder(handPlacedDir);
    assert.equal(removedByOperator.ok, true);
    assert.equal(fs.existsSync(handPlacedDir), false);
    await waitFor(() => fixture.rowNamed('night-shift') === undefined);
    const reinstalled = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.equal(reinstalled.body.hasProblem, false, reinstalled.body.text ?? '');
    await waitFor(() => fixture.rowNamed('night-shift')?.isPlacedByHand === false);
    const installedCopy = await fixture.packSources.removeHandPlacedFolder(handPlacedDir);
    assert.equal(installedCopy.ok, false);
    assert.equal(fs.existsSync(handPlacedDir), true);
    fs.writeFileSync(path.join(handPlacedDir, 'pack.json'), '{ not json');
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'invalid');
    assert.equal(fixture.rowNamed('night-shift')?.isPlacedByHand, false);
    const unreadableCopy = await fixture.packSources.removeHandPlacedFolder(handPlacedDir);
    assert.equal(unreadableCopy.ok, false);
    assert.equal(fs.existsSync(handPlacedDir), true);
    const ledgerPath = path.join(fixture.homeDir, 'packs-installed.json');
    const ledgerText = fs.readFileSync(ledgerPath, 'utf8');
    fs.writeFileSync(ledgerPath, '{ not json');
    fs.cpSync(EXAMPLE_THEME_PACK, path.join(fixture.homeDir, PACKS_DIR_NAME, 'second-copy'), { recursive: true });
    await waitFor(() => fixture.packStore.statusFrame().packs.length === 2);
    assert.deepEqual(fixture.packStore.statusFrame().packs.map((row) => row.isPlacedByHand), [false, false]);
    fs.rmSync(path.join(fixture.homeDir, PACKS_DIR_NAME, 'second-copy'), { recursive: true, force: true });
    fs.writeFileSync(ledgerPath, ledgerText);
    fs.cpSync(EXAMPLE_THEME_PACK, handPlacedDir, { recursive: true });
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'pending' && fixture.rowNamed('night-shift')?.isPlacedByHand === false);
    fs.rmSync(handPlacedDir, { recursive: true, force: true });

    fs.writeFileSync(path.join(fixture.projectDir, 'my-pack', 'pack.json'), '{ not json');
    const broken = await fixture.packs({ command: 'install', path: 'my-pack' });
    assert.equal(broken.body.hasProblem, true);
    assert.match(broken.body.text ?? '', /^Not installed/);
  } finally {
    fixture.cleanUp();
  }
});

test('an approved pack launcher, or a panel listing sessions under acts, starts a session in its project with the pack model and permission settings, a panel without it is refused, and a repository with no matching project stays disabled', async () => {
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
    ui: { panels: [{ id: 'inbox', label: 'Inbox', entry: 'inbox.html', acts: ['sessions'] }, { id: 'viewer', label: 'Viewer', entry: 'inbox.html' }] },
  }));
  fs.writeFileSync(path.join(packDir, 'inbox.html'), '<!doctype html><title>Inbox</title>');
  const unseenPackDir = path.join(homeDir, PACKS_DIR_NAME, 'unseen');
  fs.mkdirSync(unseenPackDir, { recursive: true });
  fs.writeFileSync(path.join(unseenPackDir, 'pack.json'), JSON.stringify({ name: 'unseen', version: 1, ui: { panels: [{ id: 'board', label: 'Board', entry: 'board.html', acts: ['not-yet-a-grant'] }] } }));
  fs.writeFileSync(path.join(unseenPackDir, 'board.html'), '<!doctype html><title>Board</title>');
  const panelProjectDir = path.join(homeDir, 'panel-project');
  fs.mkdirSync(panelProjectDir);
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  const clonedDir = path.join(homeDir, 'cloned-later');
  const projectPaths = [projectDir];
  const packLaunchers = createPackLaunchers({
    packStore, projectPaths: () => projectPaths, originUrl: async (projectPath) => (projectPath === clonedDir ? 'git@github.com:example-org/not-cloned.git' : 'git@github.com:example-org/other.git'),
    operatorSaneYolo: () => true, onResolved: () => {}, log: { warn: () => {} },
    runsPath: null, isSessionLive: () => true, liveSessionNames: () => [], maxScheduledSessions: () => 3, timezone: () => 'UTC',
  });
  const config: GlimmervoidConfig = { projects: [] };
  const liveSession = idleSession(projectDir);
  const connection = connectControl<{ requestId?: string; ok?: boolean; error?: string | null }>(createControlServer(controlDeps(config, { sessions: new Map([[liveSession.id, liveSession]]), packLaunchers, generateProjectId: () => `launched-${config.projects.length}` })));
  const request = (message: Record<string, unknown> & { requestId: string }) => {
    connection.send(message);
    return waitFor(() => connection.sent.some((frame) => frame.requestId === message.requestId)).then(() => connection.sent.find((frame) => frame.requestId === message.requestId));
  };
  const launch = (launcherId: string, requestId: string) => request({ type: 'pack-launch', requestId, pack: 'nightly', launcherId });
  const panelStart = (panelId: string, requestId: string, project: string) => request({ type: 'pack-session-start', requestId, pack: 'nightly', panelId, project, agent: 'claude-code', prompt: 'Triage the inbox' });
  try {
    await packStore.start();
    await waitFor(() => ['nightly', 'unseen'].every((name) => packStore.statusFrame().packs.some((row) => row.name === name)));
    const pendingRow = packStore.statusFrame().packs.find((row) => row.name === 'nightly');
    assert.deepEqual(pendingRow?.launchers.map((launcher) => launcher.prompt), [prompt, 'Hello'], 'the approval screen gets each prompt word for word');
    await packLaunchers.refresh();
    assert.deepEqual(packStore.statusFrame().launchers, [], 'an unapproved pack offers no launcher');
    assert.equal((await launch('checks', 'before-approval'))?.ok, false);
    assert.equal(config.projects.length, 0);

    const unseenRow = packStore.statusFrame().packs.find((row) => row.name === 'unseen');
    const unseenApproval = await packStore.approve(unseenRow?.fingerprint ?? '');
    assert.equal(unseenApproval.ok, false, 'a pack with errors cannot be approved, so a later schema cannot turn on a grant nobody saw');
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

    assert.equal((await panelStart('viewer', 'viewer-start', panelProjectDir))?.ok, false, 'a panel without the sessions act is refused');
    const panelStarted = await panelStart('inbox', 'inbox-start', panelProjectDir);
    assert.equal(panelStarted?.ok, true, panelStarted?.error ?? '');
    const panelProject = config.projects.find((added) => added.path === panelProjectDir);
    assert.equal(panelProject?.name, 'Inbox');
    assert.equal(panelProject?.dangerouslySkipPermissions, true, 'the pack sessions settings apply to panel sessions too');
    const send = (panelId: string, requestId: string, id: string) => request({ type: 'pack-session-send', requestId, pack: 'nightly', panelId, id, text: 'Now the next one' });
    assert.equal((await send('viewer', 'viewer-send', liveSession.id))?.ok, false, 'a panel without the sessions act cannot type into a session');
    assert.equal((await send('inbox', 'unknown-send', 'no-such-session'))?.ok, false);
    const typed = await send('inbox', 'inbox-send', liveSession.id);
    assert.equal(typed?.ok, true, typed?.error ?? '');
  } finally {
    packStore.stop();
    liveSession.destroy();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a scheduled pack launcher starts a session on its cron in the operator timezone, skips a run while its last one is live across a restart, while its project matches nothing or when it comes due late, and never catches up missed runs', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-schedules-'));
  const projectDir = path.join(homeDir, 'nightly-project');
  fs.mkdirSync(projectDir);
  const packDir = path.join(homeDir, PACKS_DIR_NAME, 'nightly');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
    name: 'nightly', version: 1,
    launchers: [
      { id: 'checks', label: 'Nightly checks', project: projectDir, agent: 'codex', prompt: 'Run the nightly checks.', schedule: '0 3 * * *' },
      { id: 'elsewhere', label: 'Elsewhere', project: 'example-org/not-cloned', agent: 'codex', prompt: 'Hello', schedule: '0 3 * * *' },
    ],
  }));
  const hourMs = 60 * 60 * 1000;
  const firstFireAt = Date.parse('2026-11-13T03:00:00Z');
  let nowMs = firstFireAt - hourMs;
  const armedTimers: { fire: () => void; delayMs: number }[] = [];
  const endedSessionIds = new Set<string>();
  let operatorTimezone = 'UTC';
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  const config: GlimmervoidConfig = { projects: [] };
  const launcherDeps = {
    packStore, projectPaths: () => [projectDir], originUrl: async () => 'git@github.com:example-org/other.git',
    operatorSaneYolo: () => true, onResolved: () => {}, log: { warn: () => {} }, runsPath: packLauncherRunsPath(homeDir),
    isSessionLive: (sessionId: string) => config.projects.some((project) => project.id === sessionId) && !endedSessionIds.has(sessionId),
    liveSessionNames: () => config.projects.map((project) => project.name), maxScheduledSessions: () => 3, timezone: () => operatorTimezone,
    now: () => nowMs,
    setTimeoutFn: (fire: () => void, delayMs: number) => {
      armedTimers.push({ fire, delayMs });
      return setTimeout(() => {}, 0);
    },
  };
  const packLaunchers = createPackLaunchers(launcherDeps);
  createControlServer(controlDeps(config, { packLaunchers, generateProjectId: () => `scheduled-${config.projects.length}` }));
  const fireArmedTimer = async (atMs: number) => {
    nowMs = atMs;
    const timersBefore = armedTimers.length;
    armedTimers.at(-1)?.fire();
    await waitFor(() => armedTimers.length > timersBefore);
  };
  try {
    await packStore.start();
    await waitFor(() => packStore.statusFrame().packs.some((row) => row.name === 'nightly'));
    const pendingRow = packStore.statusFrame().packs.find((row) => row.name === 'nightly');
    assert.deepEqual(pendingRow?.launchers.map((launcher) => launcher.schedule), ['0 3 * * *', '0 3 * * *'], 'the approval screen gets each schedule word for word');
    await packLaunchers.refresh();
    assert.equal(armedTimers.length, 0, 'an unapproved pack schedules nothing');

    assert.deepEqual(await packStore.approve(pendingRow?.fingerprint ?? ''), { ok: true });
    await packLaunchers.refresh();
    assert.equal(armedTimers.at(-1)?.delayMs, hourMs);

    await fireArmedTimer(firstFireAt);
    assert.deepEqual(config.projects.map((project) => project.name), ['Nightly checks'], 'the launcher whose project matches nothing does not fire');
    assert.equal(armedTimers.at(-1)?.delayMs, 24 * hourMs);

    await fireArmedTimer(firstFireAt + 24 * hourMs);
    assert.equal(config.projects.length, 1, 'a run is skipped while the last scheduled session is live');

    endedSessionIds.add(config.projects[0]?.id ?? '');
    await fireArmedTimer(firstFireAt + 48 * hourMs);
    assert.deepEqual(config.projects.map((project) => project.name), ['Nightly checks', 'Nightly checks (2)']);

    nowMs = firstFireAt + 96 * hourMs + hourMs / 2;
    const restarted = createPackLaunchers(launcherDeps);
    const startedAfterRestart: string[] = [];
    await restarted.refresh();
    restarted.attachSessionStarter(async (request) => {
      startedAfterRestart.push(request.name);
      return { ok: true, sessionId: request.name };
    });
    assert.equal(armedTimers.at(-1)?.delayMs, 24 * hourMs - hourMs / 2, 'after downtime the next run is the next cron time, not the missed ones');
    assert.deepEqual(startedAfterRestart, []);

    const runsPath = packLauncherRunsPath(homeDir);
    const savedRunsPath = `${runsPath}.saved`;
    fs.renameSync(runsPath, savedRunsPath);
    fs.mkdirSync(runsPath);
    await fireArmedTimer(firstFireAt + 120 * hourMs);
    assert.deepEqual(startedAfterRestart, [], 'an unreadable record of past runs skips the run instead of starting a second session');
    fs.rmdirSync(runsPath);
    fs.renameSync(savedRunsPath, runsPath);

    await fireArmedTimer(firstFireAt + 144 * hourMs);
    assert.deepEqual(startedAfterRestart, [], 'the run started before the restart is still live, so this one is skipped');

    endedSessionIds.add(config.projects[1]?.id ?? '');
    await fireArmedTimer(firstFireAt + 168 * hourMs + 2 * hourMs);
    assert.deepEqual(startedAfterRestart, [], 'a run that comes due hours late, as after the host slept, is skipped as missed');

    nowMs = firstFireAt + 192 * hourMs - 2 * hourMs;
    operatorTimezone = 'Europe/Berlin';
    await restarted.refresh();
    assert.equal(armedTimers.at(-1)?.delayMs, hourMs, 'a timezone change moves the next run to 03:00 in the new timezone');
  } finally {
    packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('an approved pack listing status pages gets their open incidents in the packs frame, refuses an oversize or non-statuspage reply, and shares one read per page with the GitHub outage check', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-status-'));
  const githubUrl = 'https://www.githubstatus.com/api/v2/summary.json';
  const oversizeUrl = 'https://status.example.com/api/v2/summary.json';
  const htmlUrl = 'https://down.example.com/api/v2/summary.json';
  const packDir = path.join(homeDir, PACKS_DIR_NAME, 'outage-watch');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: 'outage-watch', version: 1, status: { urls: [githubUrl, oversizeUrl, htmlUrl] } }));
  const githubSummary = {
    page: { name: 'GitHub' },
    incidents: [
      { name: 'Actions delayed', status: 'investigating', impact: 'minor', shortlink: 'https://stspg.io/a', updated_at: '2026-11-12T10:00:00Z' },
      { name: 'Old outage', status: 'resolved', updated_at: '2026-11-11T10:00:00Z' },
    ],
  };
  const readsByUrl = new Map<string, number>();
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    readsByUrl.set(url, (readsByUrl.get(url) ?? 0) + 1);
    if (url === githubUrl) return new Response(JSON.stringify(githubSummary));
    if (url === oversizeUrl) return new Response('x'.repeat(600 * 1024));
    return new Response('<html>down</html>');
  }) as typeof fetch;
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: packsStatePath(homeDir), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  let changeCount = 0;
  const providerStatus = createProviderStatus({ fetchFn, log: { warn: () => {} }, onChange: () => { changeCount += 1; } });
  const githubStatus = createGithubStatus({ providerStatus });
  packStore.setProviderStatuses(providerStatus.statuses);
  try {
    await packStore.start();
    await waitFor(() => packStore.statusFrame().packs.some((row) => row.name === 'outage-watch'));
    const row = packStore.statusFrame().packs.find((candidate) => candidate.name === 'outage-watch');
    assert.deepEqual(row?.statusUrls, [githubUrl, oversizeUrl, htmlUrl]);
    assert.deepEqual(packStore.statusUrlsInUse(), [], 'an unapproved pack reads no status page');

    assert.deepEqual(await packStore.approve(row?.fingerprint ?? ''), { ok: true });
    await waitFor(() => packStore.statusUrlsInUse().length === 3);
    await providerStatus.track(packStore.statusUrlsInUse());
    assert.ok(changeCount > 0);

    const providersByUrl = new Map(packStore.statusFrame().providers.map((provider) => [provider.url, provider]));
    assert.equal(providersByUrl.get(githubUrl)?.name, 'GitHub');
    assert.deepEqual(providersByUrl.get(githubUrl)?.incidents.map((incident) => [incident.name, incident.url]), [['Actions delayed', 'https://stspg.io/a']]);
    assert.match(providersByUrl.get(oversizeUrl)?.error ?? '', /over 524288 bytes/);
    assert.equal(providersByUrl.get(htmlUrl)?.error, 'the reply is not a statuspage summary JSON');
    assert.deepEqual(providersByUrl.get(htmlUrl)?.incidents, []);

    githubStatus.noteTransientFailure();
    await providerStatus.track(packStore.statusUrlsInUse());
    assert.equal(githubStatus.incident(), 'Actions delayed');
    assert.equal(readsByUrl.get(githubUrl), 1, 'the pack and the outage check share one read inside five minutes');
  } finally {
    await providerStatus.track([]);
    packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

async function servePreviews(homeDir: string) {
  const app = express();
  mountPackPreviewRoutes(app, createBoardPackPreviews({ env: process.env, homeDir, pagesDir: path.join(homeDir, 'pack-previews') }));
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  return { origin: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}

test('an agent previews a pack folder as a page card that Glimmervoid itself serves, one stable address per folder that survives a restart, while the pack stays uninstalled and unapproved', async () => {
  const fixture = selfServiceFixture();
  const restartedServer = await servePreviews(fixture.homeDir);
  try {
    await fixture.packStore.start();
    const previewed = await fixture.packs({ command: 'preview', path: 'my-pack' });
    assert.equal(previewed.status, 200, previewed.body.error ?? '');
    assert.match(previewed.body.text ?? '', /night-shift[\s\S]*Preview: showed the page as box b1/);
    const [shown] = fixture.shownOnBoard;
    assert.equal(shown?.callerId, fixture.session.id);
    const showRequest = shown?.request as { sub: string; path: string };
    assert.equal(showRequest.sub, 'show');
    const wrapperPage = fs.readFileSync(showRequest.path, 'utf8');
    const previewPath = /\.src = "(\/pack-previews\/[0-9a-f]{32}\/)"/.exec(wrapperPage)?.[1] ?? '';
    assert.notEqual(previewPath, '', wrapperPage);

    const hostPage = await fetch(`${restartedServer.origin}${previewPath}`);
    assert.match(await hostPage.text(), /Pack preview: night-shift/);
    assert.match(hostPage.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts allow-forms/);
    const action = await fetch(`${restartedServer.origin}${previewPath}action`, { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ panel: 'none', request: {} }) });
    assert.equal(action.headers.get('access-control-allow-origin'), 'null', 'the sandboxed board card can read what an action would send');
    assert.equal((await fetch(`${restartedServer.origin}/pack-previews/${'0'.repeat(32)}/`)).status, 404);

    await fixture.packs({ command: 'preview', path: 'my-pack' });
    const secondShow = fixture.shownOnBoard[1]?.request as { path: string } | undefined;
    assert.ok(fs.readFileSync(secondShow?.path ?? '', 'utf8').includes(previewPath), 'the second preview keeps the same address');
    assert.equal(fixture.rowNamed('night-shift'), undefined, 'a preview installs nothing');
  } finally {
    await restartedServer.close();
    fixture.cleanUp();
  }
});

test('an agent adds a git pack source whose packs stay off until the operator enables one, update reinstalls it so a changed pack waits for approval again, and removing the source deletes its clone and installs', async () => {
  const fixture = selfServiceFixture();
  try {
    await fixture.packStore.start();
    const remoteDir = path.join(fixture.homeDir, 'remotes', 'team', 'packs');
    fs.cpSync(EXAMPLE_THEME_PACK, path.join(remoteDir, 'themes', 'night-shift'), { recursive: true });
    assert.ok((await runGit(['init', '-q', '-b', 'main'], { cwd: remoteDir })).ok);
    await commitAll(remoteDir, 'add night-shift');

    const refused = await fixture.packs({ command: 'add', url: 'http://example.test/team/packs' });
    assert.match(refused.body.text ?? '', /is not a pack source: give the https URL/);
    const added = await fixture.packs({ command: 'add', url: `${TEST_GIT_HOST}team/packs.git` });
    assert.equal(added.body.hasProblem, false, added.body.text ?? '');
    assert.match(added.body.text ?? '', /its packs: night-shift\. Each stays off until the operator enables it/);
    const [source] = fixture.packSources.rows();
    assert.deepEqual(source?.packs.map((pack) => [pack.name, pack.isEnabled]), [['night-shift', false]]);
    assert.deepEqual(source?.packs.map(({ version, kinds, iconDataUrl }) => ({ version, kinds, iconDataUrl })), [{ version: 1, kinds: ['2 themes'], iconDataUrl: null }]);
    assert.match(source?.packs[0]?.description ?? '', /^Themes only/);
    assert.equal(fixture.rowNamed('night-shift'), undefined, 'adding a source installs nothing');

    const enabled = await fixture.packSources.setPackEnabled(source?.slug ?? '', 'night-shift', true);
    assert.ok(enabled.ok, enabled.ok ? '' : enabled.error);
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'pending');
    assert.deepEqual(await fixture.packStore.approve(fixture.rowNamed('night-shift')?.fingerprint ?? ''), { ok: true });
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'approved');

    const manifestPath = path.join(remoteDir, 'themes', 'night-shift', 'pack.json');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"version": 1', '"version": 2'));
    await commitAll(remoteDir, 'bump night-shift');
    const updated = await fixture.packs({ command: 'update' });
    assert.match(updated.body.text ?? '', /night-shift reinstalled/);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 2);
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending', 'a changed pack from a source asks the operator again');

    const otherRemoteDir = path.join(fixture.homeDir, 'remotes', 'team-b', 'packs');
    fs.cpSync(EXAMPLE_THEME_PACK, path.join(otherRemoteDir, 'night-shift'), { recursive: true });
    assert.ok((await runGit(['init', '-q', '-b', 'main'], { cwd: otherRemoteDir })).ok);
    await commitAll(otherRemoteDir, 'add night-shift');
    const otherAdded = await fixture.packs({ command: 'add', url: `${TEST_GIT_HOST}team-b/packs` });
    assert.equal(otherAdded.body.hasProblem, false, otherAdded.body.text ?? '');
    const otherSource = fixture.packSources.rows().find((row) => row.slug !== source?.slug);
    assert.notEqual(otherSource?.dir, source?.dir, 'two repositories get two clones');
    const clash = await fixture.packSources.setPackEnabled(otherSource?.slug ?? '', 'night-shift', true);
    assert.ok(!clash.ok && /already enabled from/.test(clash.error), 'a second source cannot take over an installed pack name');
    fs.rmSync(otherRemoteDir, { recursive: true, force: true });
    const failedUpdate = await fixture.packs({ command: 'update', url: `${TEST_GIT_HOST}team-b/packs` });
    assert.equal(failedUpdate.body.hasProblem, true, 'an update whose fetch fails reports a problem');
    assert.deepEqual(await fixture.packSources.remove(otherSource?.slug ?? ''), { ok: true, text: `Removed the pack source ${otherSource?.slug}` });
    assert.equal(fixture.rowNamed('night-shift')?.dir.endsWith('night-shift'), true, 'removing the other source leaves the first source install');

    assert.equal((await fixture.packs({ command: 'remove', name: 'night-shift' })).body.hasProblem, false);
    await waitFor(() => fixture.rowNamed('night-shift') === undefined);
    const afterRemoval = await fixture.packs({ command: 'update' });
    assert.match(afterRemoval.body.text ?? '', /night-shift was removed since it was enabled/);
    await waitFor(() => fixture.packSources.rows()[0]?.packs[0]?.isEnabled === false);
    assert.equal(fixture.rowNamed('night-shift'), undefined, 'an update never brings back a pack removed since it was enabled');

    const elsewhereDir = path.join(fixture.homeDir, 'elsewhere-checkout');
    fs.renameSync(source?.dir ?? '', elsewhereDir);
    fs.symlinkSync(elsewhereDir, source?.dir ?? '');
    const redirected = await fixture.packs({ command: 'update' });
    assert.equal(redirected.body.hasProblem, true);
    assert.match(redirected.body.text ?? '', /is not the clone Glimmervoid made/, 'update refuses a clone folder replaced by a link to another checkout');
    fs.rmSync(source?.dir ?? '');
    fs.renameSync(elsewhereDir, source?.dir ?? '');

    const removed = await fixture.packSources.remove(source?.slug ?? '');
    assert.ok(removed.ok, removed.ok ? '' : removed.error);
    await waitFor(() => fixture.rowNamed('night-shift') === undefined);
    assert.equal(fs.existsSync(source?.dir ?? ''), false, 'the clone is deleted');
    assert.deepEqual(fixture.packSources.rows().map((row) => row.slug), [EXAMPLES_SOURCE_SLUG], 'only the built-in examples source is left');
  } finally {
    fixture.cleanUp();
  }
});

test('an example enabled from the built-in Glimmervoid examples source follows a changed bundled copy while the server runs and at start, asking for approval again, and the source is neither updated nor removed', async () => {
  const fixture = selfServiceFixture();
  const bundledManifestPath = path.join(fixture.bundledExamplesDir, 'night-shift', 'pack.json');
  const bumpBundledVersion = (from: number, to: number) => fs.writeFileSync(bundledManifestPath, fs.readFileSync(bundledManifestPath, 'utf8').replace(`"version": ${from}`, `"version": ${to}`));
  let restarted: ReturnType<typeof fixture.newPackSources> | null = null;
  try {
    await fixture.packStore.start();
    await fixture.packSources.start();
    const examplesRow = () => fixture.packSources.rows().find((row) => row.slug === EXAMPLES_SOURCE_SLUG);
    assert.equal(examplesRow()?.isBuiltIn, true);
    assert.equal(examplesRow()?.dir, fixture.bundledExamplesDir);
    assert.deepEqual(examplesRow()?.packs.map((pack) => [pack.name, pack.isEnabled]), [['night-shift', false]]);

    const handPlacedDir = path.join(fixture.homeDir, PACKS_DIR_NAME, 'night-shift');
    fs.cpSync(EXAMPLE_THEME_PACK, handPlacedDir, { recursive: true });
    const blocked = await fixture.packSources.setPackEnabled(EXAMPLES_SOURCE_SLUG, 'night-shift', true);
    assert.ok(!blocked.ok && /Remove folder/.test(blocked.error), 'a hand-placed folder blocking an enable points at Remove folder');
    assert.ok((await fixture.packSources.removeHandPlacedFolder(handPlacedDir)).ok);

    const enabled = await fixture.packSources.setPackEnabled(EXAMPLES_SOURCE_SLUG, 'night-shift', true);
    assert.ok(enabled.ok, enabled.ok ? '' : enabled.error);
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'pending' && fixture.rowNamed('night-shift')?.isPlacedByHand === false);
    assert.deepEqual(await fixture.packStore.approve(fixture.rowNamed('night-shift')?.fingerprint ?? ''), { ok: true });
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'approved');

    bumpBundledVersion(1, 2);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 2, 'a changed bundled example is reinstalled while the server runs', 5000);
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending', 'the followed example asks for approval again');
    assert.deepEqual(await fixture.packStore.approve(fixture.rowNamed('night-shift')?.fingerprint ?? ''), { ok: true });
    await waitFor(() => fixture.rowNamed('night-shift')?.state === 'approved');

    const updateRefused = await fixture.packSources.update(EXAMPLES_SOURCE_SLUG);
    assert.ok(!updateRefused.ok && /follow Glimmervoid itself/.test(updateRefused.error));
    const removeRefused = await fixture.packSources.remove(EXAMPLES_SOURCE_SLUG);
    assert.ok(!removeRefused.ok && /stay listed/.test(removeRefused.error));
    const updateAll = await fixture.packs({ command: 'update' });
    assert.match(updateAll.body.text ?? '', /no pack sources to update/, 'updating every source leaves the built-in one out');

    fixture.packSources.stop();
    restarted = fixture.newPackSources();
    await restarted.start();
    assert.equal(fixture.rowNamed('night-shift')?.state, 'approved', 'an unchanged example is left alone at start');
    restarted.stop();
    bumpBundledVersion(2, 3);
    restarted = fixture.newPackSources();
    await restarted.start();
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 3, 'an example changed while the server was down is reinstalled at start');
    assert.equal(fixture.rowNamed('night-shift')?.state, 'pending');

    restarted.stop();
    const forkDir = path.join(fixture.projectDir, 'night-shift-fork');
    fs.cpSync(path.join(fixture.bundledExamplesDir, 'night-shift'), forkDir, { recursive: true });
    const forkManifestPath = path.join(forkDir, 'pack.json');
    fs.writeFileSync(forkManifestPath, fs.readFileSync(forkManifestPath, 'utf8').replace('"version": 3', '"version": 7'));
    assert.equal((await fixture.packs({ command: 'install', path: 'night-shift-fork' })).body.hasProblem, false);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 7);
    restarted = fixture.newPackSources();
    await restarted.start();
    assert.equal(fixture.rowNamed('night-shift')?.version, 7, 'a pack another install replaced is never reinstalled over by following');
    assert.equal(restarted.rows().find((row) => row.isBuiltIn)?.packs[0]?.isEnabled, false, 'the replaced example is off in the examples source');

    const adopted = await restarted.setPackEnabled(EXAMPLES_SOURCE_SLUG, 'night-shift', true);
    assert.ok(adopted.ok, adopted.ok ? '' : adopted.error);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 3, 'enabling an example over a pack Glimmervoid installed replaces it');
    restarted.stop();

    restarted = fixture.newPackSources(100);
    await restarted.start();
    const movedAwayDir = path.join(fixture.homeDir, 'examples-moved-away');
    fs.renameSync(fixture.bundledExamplesDir, movedAwayDir);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.cpSync(movedAwayDir, fixture.bundledExamplesDir, { recursive: true });
    fs.rmSync(movedAwayDir, { recursive: true, force: true });
    bumpBundledVersion(3, 4);
    await waitFor(() => fixture.rowNamed('night-shift')?.version === 4, 'an examples folder that was gone for a while is watched again once it is back', 5000);
  } finally {
    restarted?.stop();
    fixture.cleanUp();
  }
});

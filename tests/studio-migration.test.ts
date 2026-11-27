import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { migrateStudioToAcp, moveStudioToOneOrchestrator } from '../server/board-session/studio-migration.ts';
import { createStudioReposStore } from '../server/board-session/studio-repos-store.ts';
import { createCodemapService } from '../server/codemap/codemap-wiring.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { loadConfigFile } from '../server/config/config-file.ts';
import { createControlContext } from '../server/control/control-context.ts';
import { createSessionHandlers } from '../server/control/handlers/session-handlers.ts';
import { createSettingsHandlers } from '../server/control/handlers/settings-handlers.ts';
import { folderCardIdOf, moduleBoxIdOf, rootBoxIdOf } from '../server/core/codemap-graph-core.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { createSessionRegistry } from '../server/session/session-registry.ts';
import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import { SESSION_DRIVER_EVENTS } from '../session/drivers/driver.ts';
import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { Op } from '../shared/contracts/whiteboard.ts';
import { CODEMAP_AUTHOR } from '../shared/contracts/whiteboard-ops-core.ts';
import { openWhiteboardWiring } from './helpers/whiteboard-closables.ts';

const LONG_MODULE_ID = 'packages/storefront/src/checkout/__tests__';
const FILE_IN_MODULE = `${LONG_MODULE_ID}/tax.test.ts`;

function unscopedMapBoxIdOf(displayPath: string, identity: string): string {
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 8);
  const slug = displayPath.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(-(40 - 'cm-'.length - hash.length - 1)).replace(/^-+|-+$/g, '');
  return `cm-${slug}-${hash}`;
}

function boxAt(id: string, title: string): unknown {
  return { op: 'add', element: { kind: 'box', id, title, place: { at: { x: 0, y: 0 } } } };
}

test('a repo opened in Studio before one Orchestrator keeps its main session as a repo root branch, its branches follow, and a second start changes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migration-'));
  const studioHome = path.join(home, 'studio-home');
  const studioReposFilePath = path.join(home, 'studio-repos.json');
  const shopDir = path.join(home, 'work', 'shop');
  const forkDir = path.join(home, 'forks', 'shop');
  const mainBeforeStudio: ProjectEntry = { id: 'main-shop', name: 'shop main', path: shopDir, agent: 'codex', accountId: 'work', agentSetup: { agent: 'codex', model: 'gpt-5.2-codex', options: [], instructions: 'be brief' }, resumeSessionId: 'conversation-1', dangerouslySkipPermissions: true };
  const config: GlimmervoidConfig = {
    ...DEFAULT_CONFIG,
    projects: [
      { ...mainBeforeStudio, isStudioMain: true },
      { id: 'main-fork', name: 'shop main 2', path: forkDir, isStudioMain: true },
      { id: 'branch-payments', name: 'payments', path: shopDir, parent: { sessionId: 'main-shop', box: { id: unscopedMapBoxIdOf(LONG_MODULE_ID, LONG_MODULE_ID), title: LONG_MODULE_ID, repoName: '' } } },
      { id: 'branch-file', name: 'tax test', path: shopDir, parent: { sessionId: 'main-shop', box: { id: unscopedMapBoxIdOf(LONG_MODULE_ID, LONG_MODULE_ID), title: FILE_IN_MODULE, repoName: '' } } },
      { id: 'branch-folder', name: 'storefront', path: shopDir, parent: { sessionId: 'main-shop', box: { id: unscopedMapBoxIdOf('packages/storefront folder', 'folder\npackages/storefront'), title: 'packages/storefront', repoName: '' } } },
      { id: 'child-of-main', name: 'helper', path: shopDir, parent: { sessionId: 'main-shop', box: null } },
      { id: 'plain', name: 'plain session', path: shopDir },
    ],
  };
  const configStore = { save: (mutate: (savedConfig: GlimmervoidConfig) => unknown) => { mutate(config); return config; } };
  const logged: string[] = [];
  const migrate = () => moveStudioToOneOrchestrator({ config, configStore, studioHome, studioReposFilePath, logger: { log: (line: string) => { logged.push(line); }, warn: (line: string) => { logged.push(line); } } });
  try {
    migrate();
    const repos = z.object({ repos: z.array(z.object({ repoKey: z.string(), repoName: z.string(), repoDir: z.string(), branchAgent: z.unknown() })) }).parse(JSON.parse(fs.readFileSync(studioReposFilePath, 'utf8'))).repos;
    assert.deepEqual(repos.map((repo) => [repo.repoName, repo.repoDir]), [['shop', shopDir], ['shop-2', forkDir]], 'each repo joins the Studio repo list under a name of its own');
    const [shopRepo, forkRepo] = repos;
    assert.ok(shopRepo && forkRepo);
    assert.deepEqual(shopRepo.branchAgent, { agentId: 'codex', accountId: 'work', setup: { agent: 'codex', model: 'gpt-5.2-codex', options: [] } }, 'the repo keeps the agent and model its main ran, for its next branches');

    const orchestrator = config.projects.find((project) => project.isStudioMain === true);
    assert.ok(orchestrator?.id);
    assert.equal(orchestrator.studioRole, 'orchestrator');
    assert.deepEqual({ name: orchestrator.name, path: orchestrator.path, agent: orchestrator.agent, accountId: orchestrator.accountId, dangerouslySkipPermissions: orchestrator.dangerouslySkipPermissions }, { name: 'Orchestrator', path: studioHome, agent: 'codex', accountId: 'work', dangerouslySkipPermissions: true });
    assert.equal(config.projects.filter((project) => project.isStudioMain === true).length, 1, 'one Orchestrator is left');
    assert.ok(fs.statSync(studioHome).isDirectory());

    const movedMain = config.projects.find((project) => project.id === 'main-shop');
    assert.deepEqual(movedMain, { ...mainBeforeStudio, parent: { sessionId: orchestrator.id, box: { id: rootBoxIdOf(shopRepo.repoKey), title: 'repo root', repoName: 'shop' } } }, 'the former main keeps its id, folder, agent and conversation, and is now a branch on the root of its repo');
    assert.equal(config.projects.find((project) => project.id === 'main-fork')?.parent?.box?.repoName, 'shop-2');
    assert.deepEqual(config.projects.find((project) => project.id === 'branch-payments')?.parent, { sessionId: orchestrator.id, box: { id: moduleBoxIdOf(shopRepo.repoKey, LONG_MODULE_ID), title: LONG_MODULE_ID, repoName: 'shop' } }, 'a branch of the former main follows to the Orchestrator, on the same box in the area of its repo');
    assert.equal(config.projects.find((project) => project.id === 'branch-file')?.parent?.box?.id, moduleBoxIdOf(shopRepo.repoKey, LONG_MODULE_ID), 'a branch started on a file stays on the box of the module that holds it');
    assert.equal(config.projects.find((project) => project.id === 'branch-folder')?.parent?.box?.id, folderCardIdOf(shopRepo.repoKey, 'packages/storefront'), 'a branch started on a folder stays on that folder card');
    assert.deepEqual(config.projects.find((project) => project.id === 'child-of-main')?.parent, { sessionId: 'main-shop', box: null }, 'an agent child of the former main stays its child');
    assert.deepEqual(config.projects.find((project) => project.id === 'plain'), { id: 'plain', name: 'plain session', path: shopDir });

    const projectsAfterFirstStart = structuredClone(config.projects);
    const reposTextAfterFirstStart = fs.readFileSync(studioReposFilePath, 'utf8');
    migrate();
    moveStudioToOneOrchestrator({ config, configStore, studioHome: path.join(home, 'moved-home', 'studio-home'), studioReposFilePath, logger: { log: (line: string) => { logged.push(line); }, warn: (line: string) => { logged.push(line); } } });
    assert.deepEqual(config.projects, projectsAfterFirstStart, 'the move runs once: a later start, even with the Studio home moved, never takes the Orchestrator for a repo main');
    assert.equal(fs.readFileSync(studioReposFilePath, 'utf8'), reposTextAfterFirstStart);
    assert.equal(logged.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the per-repo map boards are removed at start, and one that holds more than its map is kept whole', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migration-boards-'));
  const perRepoMapBoardsFilePath = path.join(home, 'codemap-boards.json');
  const whiteboards = openWhiteboardWiring({ boardsRoot: path.join(home, 'boards') });
  const shopDir = path.join(home, 'shop');
  const docsDir = path.join(home, 'docs');
  const mapOnlyBoardId = (await whiteboards.handleOperator.create('Code map: shop')).summary?.id ?? '';
  const sharedBoardId = (await whiteboards.handleOperator.create('Code map: docs')).summary?.id ?? '';
  const mapCaller = (repoDir: string) => ({ id: CODEMAP_AUTHOR.id, name: CODEMAP_AUTHOR.name, project: repoDir });
  const mapBoxId = unscopedMapBoxIdOf('lib', 'lib');
  assert.equal((await whiteboards.putWithoutReadCheck(mapCaller(shopDir), mapOnlyBoardId, z.array(Op).parse([boxAt(mapBoxId, 'lib')]))).status, 200);
  assert.equal((await whiteboards.putWithoutReadCheck(mapCaller(docsDir), sharedBoardId, z.array(Op).parse([boxAt(mapBoxId, 'lib')]))).status, 200);
  assert.equal((await whiteboards.handleOperator.put(sharedBoardId, z.array(Op).parse([boxAt('operator-note', 'Ship the refunds first'), { op: 'add', element: { kind: 'frame', id: 'payments-group', title: 'Payments team owns these', contains: [mapBoxId] } }]))).ok, true);
  fs.writeFileSync(perRepoMapBoardsFilePath, JSON.stringify({ [shopDir]: mapOnlyBoardId, [docsDir]: sharedBoardId, [path.join(home, 'gone')]: 'no-such-board' }));
  const codemap = createCodemapService({ whiteboards, perRepoMapBoardsFilePath, areas: createStudioReposStore({ filePath: path.join(home, 'studio-repos.json'), logger: console }), specsRoot: path.join(home, 'specs'), logger: { warn: () => {} } });
  try {
    await codemap.removePerRepoMapBoards();
    const boardTitles = whiteboards.snapshotMessage().boards.map((board) => board.title);
    assert.deepEqual(boardTitles, ['Code map: docs'], 'a board that held only a map is deleted');
    const keptBoard = await whiteboards.boardOf(sharedBoardId);
    assert.deepEqual([...(keptBoard?.elements.keys() ?? [])].sort(), [mapBoxId, 'operator-note', 'payments-group'].sort(), 'a map board the operator also drew on is kept whole, with the frame they put around a map box');
    assert.equal(fs.existsSync(perRepoMapBoardsFilePath), false, 'the per-repo board list is gone, so the next start has nothing to remove');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pre-P3.1 Studio sessions migrate onto ACP in one write, non-ACP Studio projects stay stopped with a note and unchanged agent, and a second run changes nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-acp-migration-'));
  const studioHome = path.join(home, 'studio-home');
  const repoDir = path.join(home, 'repo');
  const tracesDir = path.join(home, 'traces');
  const configPath = path.join(home, 'config.json');
  fs.mkdirSync(studioHome, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const config: GlimmervoidConfig = {
    ...DEFAULT_CONFIG,
    projects: [
      {
        id: 'studio-orch',
        name: 'Orchestrator',
        path: studioHome,
        agent: 'claude-code',
        isStudioMain: true,
        studioRole: 'orchestrator',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440001',
        wasActive: true,
      },
      {
        id: 'studio-branch',
        name: 'repo lib',
        path: repoDir,
        agent: 'codex',
        driverKind: 'pty',
        parent: { sessionId: 'studio-orch', box: { id: 'cm-lib', title: 'lib', repoName: 'repo' } },
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440002',
        wasActive: true,
      },
      {
        id: 'studio-blocked',
        name: 'repo app',
        path: repoDir,
        agent: 'kimi',
        driverKind: 'pty',
        parent: { sessionId: 'studio-orch', box: { id: 'cm-app', title: 'app', repoName: 'repo' } },
        wasActive: true,
        wasWorking: true,
      },
      {
        id: 'focus-plain',
        name: 'Focus',
        path: repoDir,
        agent: 'kimi',
      },
    ],
  };
  let saveCalls = 0;
  const configStore = {
    save: (mutate: (savedConfig: GlimmervoidConfig) => unknown) => {
      saveCalls += 1;
      mutate(config);
      return config;
    },
  };
  const logs: string[] = [];
  const logger = {
    log: (line: string) => { logs.push(line); },
    warn: (line: string) => { logs.push(line); },
  };
  try {
    migrateStudioToAcp({ config, configStore, tracesDir, logger });
    assert.equal(saveCalls, 1, 'migration persists config in one write');

    const migratedOrch = config.projects.find((project) => project.id === 'studio-orch');
    const migratedBranch = config.projects.find((project) => project.id === 'studio-branch');
    const blockedBranch = config.projects.find((project) => project.id === 'studio-blocked');
    const focusProject = config.projects.find((project) => project.id === 'focus-plain');
    assert.equal(migratedOrch?.driverKind, 'acp');
    assert.equal(migratedOrch?.resumeSessionId, '550e8400-e29b-41d4-a716-446655440001');
    assert.equal(migratedOrch?.acpMigrationFreshFallback, true);
    assert.equal(migratedBranch?.driverKind, 'acp');
    assert.equal(migratedBranch?.resumeSessionId, '550e8400-e29b-41d4-a716-446655440002');
    assert.equal(migratedBranch?.acpMigrationFreshFallback, true);

    assert.equal(blockedBranch?.agent, 'kimi', 'non-ACP Studio project never has its agent switched');
    assert.equal(blockedBranch?.driverKind, undefined);
    assert.equal(blockedBranch?.wasActive, false);
    assert.equal(blockedBranch?.wasWorking, false);
    assert.equal(blockedBranch?.acpMigrationBlockedNoted, true);
    assert.equal(focusProject?.driverKind, undefined, 'Focus session is untouched');

    const blockedTracePath = path.join(tracesDir, 'studio-blocked.jsonl');
    const blockedLines = fs.readFileSync(blockedTracePath, 'utf8').trim().split('\n');
    assert.equal(blockedLines.length, 1);
    const blockedNotice = JSON.parse(blockedLines[0] ?? '{}') as { kind?: string; text?: string };
    assert.equal(blockedNotice.kind, 'notice');
    assert.match(blockedNotice.text ?? '', /kimi.*no ACP row/i);
    assert.match(blockedNotice.text ?? '', /pick an agent Studio can run/i);

    const makeSession = createSessionFactory({
      configStore: { configPath },
      getConfig: () => config,
      hookRouter: null,
      getHookPort: () => null,
      getGitWorkspace: () => null,
      resolveHookTools: () => [],
      getUserHooks: () => [],
    });
    assert.ok(migratedOrch && migratedBranch && blockedBranch && focusProject);
    const orchSession = makeSession(migratedOrch, config);
    const branchSession = makeSession(migratedBranch, config);
    const blockedSession = makeSession(blockedBranch, config);
    const focusSession = makeSession(focusProject, config);
    assert.equal(orchSession.hasTerminal, false);
    assert.equal(branchSession.hasTerminal, false);
    assert.equal(blockedSession.hasTerminal, false);
    assert.equal(blockedSession.agentId, 'kimi');
    assert.equal(blockedSession.state, STATES.DORMANT);
    await blockedSession.start();
    assert.equal(blockedSession.state, STATES.DORMANT);
    assert.equal(focusSession.hasTerminal, true);
    orchSession.destroy();
    branchSession.destroy();
    blockedSession.destroy();
    focusSession.destroy();

    const projectsAfterFirstRun = structuredClone(config.projects);
    const traceAfterFirstRun = fs.readFileSync(blockedTracePath, 'utf8');
    migrateStudioToAcp({ config, configStore, tracesDir, logger });
    assert.equal(saveCalls, 1, 'second migration run performs zero config writes');
    assert.deepEqual(config.projects, projectsAfterFirstRun);
    assert.equal(fs.readFileSync(blockedTracePath, 'utf8'), traceAfterFirstRun, 'second run writes no duplicate notice');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a migrated Studio session whose ACP agent rejects session/load falls back to a fresh session and emits one Studio notice', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-acp-fallback-'));
  const studioHome = path.join(home, 'studio-home');
  const tracesDir = path.join(home, 'traces');
  const configPath = path.join(home, 'config.json');
  const fakeAgentPath = path.join(home, 'reject-load-agent.mjs');
  fs.mkdirSync(studioHome, { recursive: true });
  fs.writeFileSync(fakeAgentPath, [
    'import readline from "node:readline";',
    'const rl = readline.createInterface({ input: process.stdin });',
    'const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\\n`);',
    'rl.on("line", (line) => {',
    '  const msg = JSON.parse(line);',
    '  if (msg.method === "initialize") {',
    '    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });',
    '    return;',
    '  }',
    '  if (msg.method === "session/load") {',
    '    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "session not found" } });',
    '    return;',
    '  }',
    '  if (msg.method === "session/new") {',
    '    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "550e8400-e29b-41d4-a716-446655449999" } });',
    '  }',
    '});',
  ].join('\n'));
  const config: GlimmervoidConfig = {
    ...DEFAULT_CONFIG,
    acpAgents: [{ id: 'reject-load', label: 'Reject Load', command: process.execPath, args: [fakeAgentPath] }],
    projects: [{
      id: 'studio-fallback',
      name: 'Orchestrator',
      path: studioHome,
      agent: 'reject-load',
      isStudioMain: true,
      studioRole: 'orchestrator',
      resumeSessionId: '550e8400-e29b-41d4-a716-446655440001',
    }],
  };
  const configStore = { save: (mutate: (savedConfig: GlimmervoidConfig) => unknown) => { mutate(config); return config; } };
  try {
    migrateStudioToAcp({ config, configStore, tracesDir, logger: { log: () => {}, warn: () => {} } });
    const migrated = config.projects[0];
    assert.ok(migrated);
    assert.equal(migrated.driverKind, 'acp');
    assert.equal(migrated.acpMigrationFreshFallback, true);
    const makeSession = createSessionFactory({
      configStore: { configPath },
      getConfig: () => config,
      hookRouter: null,
      getHookPort: () => null,
      getGitWorkspace: () => null,
      resolveHookTools: () => [],
      getUserHooks: () => [],
    });
    const session = makeSession(migrated, config);
    const notices: { kind?: string; text?: string }[] = [];
    session.on('conversation-records', ({ records }: { records: { kind?: string; text?: string }[] }) => {
      notices.push(...records);
    });
    const opened = new Promise<{ agentSessionId: string; isResumed: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for driver-agent-session')), 15000);
      session.once('driver-agent-session', (payload: { agentSessionId: string; isResumed: boolean }) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    await session.start();
    const agentSession = await opened;
    assert.equal(agentSession.isResumed, false);
    assert.equal(agentSession.agentSessionId, '550e8400-e29b-41d4-a716-446655449999');
    assert.equal(session.state, STATES.IDLE);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind, 'notice');
    assert.match(notices[0]?.text ?? '', /earlier conversation could not be carried over/i);
    session.destroy();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a stopped Orchestrator with no ACP row offers runnable ACP agents, starts on the operator pick, and re-enters stopped if its ACP row is deleted later', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-orch-recovery-'));
  const studioHome = path.join(home, 'studio-home');
  const repoDir = path.join(home, 'repo');
  const tracesDir = path.join(home, 'traces');
  const configPath = path.join(home, 'config.json');
  const replayAgentPath = path.resolve(import.meta.dirname, 'fixtures', 'acp-replay-agent.ts');
  const claudeRecordingPath = path.resolve(import.meta.dirname, '..', 'harness', 'acp-spike', 'recordings', 'claude', 'setup.jsonl');
  fs.mkdirSync(studioHome, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const config: GlimmervoidConfig = {
    ...DEFAULT_CONFIG,
    acpAgents: [{
      id: 'replay-acp',
      label: 'Replay ACP',
      command: process.execPath,
      args: [replayAgentPath, claudeRecordingPath, '1', 'test@example.com', 'test-plan'],
    }],
    projects: [
      {
        id: 'studio-orch',
        name: 'Orchestrator',
        path: studioHome,
        agent: 'kimi',
        accountId: 'work',
        agentSetup: { agent: 'kimi', model: 'k2', options: [], instructions: '' },
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440010',
        isStudioMain: true,
        studioRole: 'orchestrator',
        wasActive: true,
      },
      {
        id: 'studio-branch',
        name: 'repo lib',
        path: repoDir,
        agent: 'kimi',
        parent: { sessionId: 'studio-orch', box: { id: 'cm-lib', title: 'lib', repoName: 'repo' } },
      },
    ],
  };
  const configStore = {
    configPath,
    config,
    save: (mutate: (savedConfig: GlimmervoidConfig) => unknown) => {
      const outcome = mutate(config);
      if (outcome !== undefined) return null;
      return config;
    },
  };
  const sessions = new Map<string, Session>();
  const broadcasts: Record<string, unknown>[] = [];
  const makeSession = createSessionFactory({
    configStore: { configPath },
    getConfig: () => config,
    hookRouter: null,
    getHookPort: () => null,
    getGitWorkspace: () => null,
    resolveHookTools: () => [],
    getUserHooks: () => [],
  });
  const registry = createSessionRegistry({
    httpServer: { listening: false, once: () => {}, off: () => {} } as never,
    sessions,
    config: config as never,
    configStore: configStore as never,
    makeSession: (project, cfg) => makeSession(project as ProjectEntry, cfg as GlimmervoidConfig),
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    notificationManager: { acknowledge: () => {} },
    broadcastControl: (message) => { broadcasts.push(message); },
    applySettingsReload: () => {},
    spawnGate: { run: async (callback) => callback() },
    gitWorkspaceSync: { listSessionWorktrees: () => [], removeWorktreeByPath: () => {} },
    reconcileSessionWorktrees: () => {},
    carryWorktreeAcrossRecreate: () => {},
    ensureProjectIds: () => false,
    resolveAgentId: (agent) => (typeof agent === 'string' && agent.trim() !== '' ? agent.trim() : 'claude-code'),
    logger: { log: () => {}, warn: () => {} },
  });
  try {
    migrateStudioToAcp({ config, configStore, tracesDir, logger: { log: () => {}, warn: () => {} } });
    registry.initialize();

    const stoppedOrch = sessions.get('studio-orch');
    assert.ok(stoppedOrch);
    assert.equal(stoppedOrch.agentId, 'kimi', 'migration never switches the Orchestrator agent');
    assert.equal(stoppedOrch.state, STATES.DORMANT);
    assert.equal(stoppedOrch.hasTerminal, false);
    assert.match(stoppedOrch.failureReason ?? '', /kimi.*no ACP row/i);
    assert.equal(projectSessionCard(stoppedOrch, { id: stoppedOrch.id, name: stoppedOrch.name }).failureReason, stoppedOrch.failureReason);

    const orchTrace = fs.readFileSync(path.join(tracesDir, 'studio-orch.jsonl'), 'utf8');
    assert.match(orchTrace, /Orchestrator card/i);
    assert.doesNotMatch(orchTrace, /closing this session/i);

    const controlContext = createControlContext({
      sessions,
      config,
      configStore: configStore as never,
      generateProjectId: () => 'unused',
      applyConfigReload: (freshConfig: GlimmervoidConfig) => { registry.applyConfigReload(freshConfig as never); },
    } as never);
    const settingsHandlers = createSettingsHandlers(controlContext, { config, configStore } as never);
    const sessionHandlers = createSessionHandlers(controlContext, {
      config,
      configStore: configStore as never,
      broadcastControl: (message: Record<string, unknown>) => { broadcasts.push(message); },
      applyConfigReload: (freshConfig: GlimmervoidConfig) => { registry.applyConfigReload(freshConfig as never); },
    } as never);
    const replies: Record<string, unknown>[] = [];
    const fakeSocket = { send: (payload: string) => { replies.push(JSON.parse(payload)); } } as never;

    const listAgents = settingsHandlers.handlers['list-agents'];
    const switchAgent = sessionHandlers.handlers['switch-session-agent'];
    assert.ok(listAgents && switchAgent);

    await listAgents({ type: 'list-agents', driver: 'acp', requestId: 'list-1' } as never, fakeSocket);
    const listed = replies.pop() as { type?: string; agents?: { id: string; resolvable: boolean }[] };
    assert.equal(listed?.type, 'agents-listed');
    const listedIds = (listed.agents ?? []).map((entry) => entry.id);
    assert.ok(listedIds.includes('replay-acp'));
    assert.ok(!listedIds.includes('kimi'));

    await switchAgent({ type: 'switch-session-agent', id: 'studio-orch', agent: 'kimi', requestId: 'sw-bad' } as never, fakeSocket);
    const refusedBadAgent = replies.pop() as { ok?: boolean; error?: string };
    assert.equal(refusedBadAgent?.ok, false);
    assert.match(refusedBadAgent?.error ?? '', /no ACP row/i);
    assert.equal(sessions.get('studio-orch')?.agentId, 'kimi');

    await switchAgent({ type: 'switch-session-agent', id: 'studio-branch', agent: 'replay-acp', requestId: 'sw-branch' } as never, fakeSocket);
    const refusedBranch = replies.pop() as { ok?: boolean; error?: string };
    assert.equal(refusedBranch?.ok, false);
    assert.match(refusedBranch?.error ?? '', /Orchestrator/i);
    assert.equal(sessions.get('studio-branch')?.agentId, 'kimi');

    await switchAgent({ type: 'switch-session-agent', id: 'studio-orch', agent: 'replay-acp', requestId: 'sw-ok' } as never, fakeSocket);
    const switched = replies.pop() as { type?: string; ok?: boolean };
    assert.equal(switched?.type, 'switch-session-agent-result');
    assert.equal(switched?.ok, true);

    const startedOrch = sessions.get('studio-orch');
    assert.ok(startedOrch);
    assert.notEqual(startedOrch, stoppedOrch);
    assert.equal(startedOrch.agentId, 'replay-acp');
    assert.equal(startedOrch.hasTerminal, false);
    assert.equal(startedOrch.failureReason, null);
    const modifiedBroadcast = broadcasts.findLast((frame) => frame.type === 'session-modified' && frame.id === 'studio-orch');
    assert.equal(modifiedBroadcast?.agent, 'replay-acp');
    assert.equal(modifiedBroadcast?.failureReason, null);

    const savedOrch = config.projects.find((project) => project.id === 'studio-orch');
    assert.equal(savedOrch?.agent, 'replay-acp');
    assert.equal(savedOrch?.driverKind, 'acp');
    assert.equal(savedOrch?.accountId, undefined);
    assert.equal(savedOrch?.agentSetup, undefined);
    assert.equal(savedOrch?.resumeSessionId, undefined);
    assert.equal(savedOrch?.acpMigrationBlockedNoted, undefined);

    await new Promise<void>((resolve, reject) => {
      if (startedOrch.state === STATES.IDLE || startedOrch.state === STATES.RUNNING) return resolve();
      const timer = setTimeout(() => reject(new Error(`timed out waiting for Orchestrator ACP start (state=${startedOrch.state})`)), 15000);
      startedOrch.once(SESSION_DRIVER_EVENTS.agentSession, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    startedOrch.destroy();

    config.acpAgents = [];
    fs.writeFileSync(configPath, JSON.stringify({ ...config, acpAgents: [] }, null, 2));
    const reloaded = loadConfigFile(configPath, { exitOnError: false, envSecrets: [] });
    assert.ok(reloaded.config, 'loadConfigFile succeeds after deleting a custom ACP row');
    const reloadedConfig = reloaded.config;
    const reloadedOrch = reloadedConfig.projects.find((project) => project.id === 'studio-orch');
    assert.ok(reloadedOrch);
    assert.equal(reloadedOrch.agent, 'replay-acp', 'loadConfigFile keeps a Studio Orchestrator whose custom ACP row was deleted');
    assert.equal(reloadedOrch.driverKind, undefined);

    migrateStudioToAcp({ config: reloadedConfig, configStore: { save: (mutate) => { mutate(reloadedConfig); return reloadedConfig; } }, tracesDir, logger: { log: () => {}, warn: () => {} } });
    const restoppedProject = reloadedConfig.projects.find((project) => project.id === 'studio-orch');
    assert.ok(restoppedProject);
    assert.equal(restoppedProject.agent, 'replay-acp', 'deleting a custom ACP row later leaves the Orchestrator agent unchanged');
    assert.equal(restoppedProject.driverKind, undefined);
    assert.equal(restoppedProject.wasActive, false);
    const restoppedSession = makeSession(restoppedProject, reloadedConfig);
    assert.equal(restoppedSession.state, STATES.DORMANT);
    assert.match(restoppedSession.failureReason ?? '', /replay-acp.*no ACP row/i);
    restoppedSession.destroy();
  } finally {
    for (const session of sessions.values()) session.destroy();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { createBranchWiring } from '../server/board-session/branch-wiring.ts';
import { ensureOrchestrator, studioHomeDir } from '../server/board-session/studio-main.ts';
import { createStudioReposStore } from '../server/board-session/studio-repos-store.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import { createCodemapService } from '../server/codemap/codemap-wiring.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { repoIdPrefixOf } from '../server/core/codemap-graph-core.ts';
import { buildSrtSettings } from '../server/sandbox/core/sandbox-policy-core.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { createMemoryAdmission, createSpawnGate } from '../server/spawn-gate.ts';
import { Session } from '../session/sessions.ts';
import { CODEMAP_ID_PREFIXES } from '../shared/contracts/whiteboard-ops-core.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { openWhiteboardWiring } from './helpers/whiteboard-closables.ts';

async function createRepoWithLibAndApp(parentDir: string, repoName: string): Promise<string> {
  const repoDir = path.join(parentDir, repoName);
  const writeSource = (repoPath: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repoDir, repoPath)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, repoPath), text);
  };
  for (let index = 0; index < 21; index++) writeSource(`lib/part${index}.ts`, `export const part${index} = ${index};`);
  for (let index = 0; index < 20; index++) writeSource(`app/screen${index}.ts`, `import { part${index} } from '../lib/part${index}.ts';\nexport const screen${index} = part${index};`);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'map me'], { cwd: repoDir });
  return repoDir;
}

test('the Orchestrator runs in the Studio home, lists every Studio repo from its code map, and starts a branch in the repo and box it names, which only it may do', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-orchestrator-'));
  const firstRepoDir = await createRepoWithLibAndApp(tmpDir, 'first');
  const secondRepoDir = await createRepoWithLibAndApp(tmpDir, 'second');
  const whiteboards = openWhiteboardWiring({ boardsRoot: path.join(tmpDir, 'boards') });
  const studioRepos = createStudioReposStore({ filePath: path.join(tmpDir, 'studio-repos.json'), logger: console });
  const codemap = createCodemapService({ whiteboards, areas: studioRepos, specsRoot: path.join(tmpDir, 'specs'), isMappedDir: (repoDir) => repoDir !== studioHomeDir() });
  const sessions = new Map<string, Session>();
  const createdProjects: ProjectEntry[] = [];
  const createProjectSession = (args: { name: string; path: string; runSettings?: Partial<ProjectEntry> }) => {
    const project: ProjectEntry = { ...args.runSettings, id: `session-${createdProjects.length + 1}`, name: args.name, path: args.path };
    createdProjects.push(project);
    sessions.set(project.id, new Session({ id: project.id, name: project.name, path: project.path, isStudioMain: project.isStudioMain === true, parent: project.parent ?? null, ptySpawn: () => fakePty() }));
    return { ok: true as const, project };
  };
  const branches = createBranchWiring({
    findSession: (sessionId) => sessions.get(sessionId) ?? null,
    listSessions: () => sessions.values(),
    listRepos: () => codemap.listedRepos(),
    repoOfBox: (boxId) => codemap.repoOfBox(boxId),
    resolveTarget: (repoDir, about) => codemap.branchTargetOf(repoDir, about),
    createProjectSession,
  });
  const config: GlimmervoidConfig = { ...DEFAULT_CONFIG, agentApi: { enabled: true }, spawnedSessionsMax: 3, projects: [] };
  let budgetHoldReason: string | null = null;
  const memoryAdmission = createMemoryAdmission({ readHeadroom: () => Promise.resolve({ ok: true as const, headroomBytes: 64 * 1024 * 1024 * 1024 }), reserveBytesFor: () => 0, warn: () => {} });
  const agentApi = createAgentApiWiring({
    config,
    agentSessions: new Map<string, Session>(),
    listAllSessions: () => [...sessions.values()],
    listBoardSessions: () => [...sessions.values()],
    makeSession: () => { throw new Error('the Orchestrator starts branches, never an agent child'); },
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    broadcastControl: () => {},
    spawnGate: createSpawnGate({ memoryAdmission }),
    sessionDocs: createSessionDocsWiring({ broadcastControl: () => {} }),
    memoryAdmission,
    codemap,
    startBranch: branches.spawn,
    budgetHoldReason: () => budgetHoldReason,
    logger: { warn: () => {} },
  });
  const spawn = (session: Session, request: Record<string, unknown>) => agentApi.handle(session, 'spawn', request);
  const errorOf = (reply: { body: unknown }) => String((reply.body as { error?: string }).error ?? '');

  const ensured = ensureOrchestrator(sessions.values(), createProjectSession, { dangerouslySkipPermissions: true });
  assert.ok(ensured.ok);
  const orchestrator = sessions.get(ensured.orchestratorId);
  assert.ok(orchestrator);
  assert.equal(orchestrator.path, studioHomeDir());
  assert.ok(fs.statSync(studioHomeDir()).isDirectory(), 'the Studio home exists before its session starts');
  assert.ok(!firstRepoDir.startsWith(studioHomeDir()) && !studioHomeDir().startsWith(firstRepoDir), 'the Studio home is outside every repo');
  assert.deepEqual(ensureOrchestrator(sessions.values(), createProjectSession, {}), { ok: true, orchestratorId: orchestrator.id, isCreated: false }, 'a second ensure reuses the one Orchestrator');

  assert.equal((await agentApi.handle(orchestrator, 'codemap', { sub: 'map' })).status, 404, 'with no Studio repo the Orchestrator has no index');
  assert.equal((await codemap.handle({ repoDir: firstRepoDir }, { sub: 'map' })).ok, true);
  assert.equal((await codemap.handle({ repoDir: secondRepoDir }, { sub: 'map' })).ok, true);
  const [firstRepo, secondRepo] = await codemap.listedRepos();
  assert.ok(firstRepo && secondRepo);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: studioHomeDir() });
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'a home inside a repo'], { cwd: studioHomeDir() });
  assert.equal((await codemap.handle({ repoDir: studioHomeDir() }, { sub: 'map' })).ok, false);
  assert.equal((await codemap.listedRepos()).some((listed) => listed.repoDir === studioHomeDir()), false, 'the Studio home never becomes a map area, even inside a git work tree');

  const index = await agentApi.handle(orchestrator, 'codemap', { sub: 'map' });
  assert.equal(index.status, 200);
  const indexText = String((index.body as { text?: string }).text);
  assert.match(indexText, new RegExp(`Repo first \\(key ${firstRepo.repoKey}\\) at ${firstRepoDir}\\n[\\s\\S]*lib \\(21, in 1\\)[\\s\\S]*Repo second \\(key ${secondRepo.repoKey}\\) at ${secondRepoDir}`));
  assert.equal((await agentApi.handle(orchestrator, 'codemap', { sub: 'check' })).status, 400, 'a per-checkout action is refused for a session with no checkout');

  assert.equal((await spawn(orchestrator, { prompt: 'fix the parts' })).status, 400, 'the Orchestrator names a repo and a box');
  const unknownRepo = await spawn(orchestrator, { prompt: 'fix the parts', repo: 'third', about: 'lib' });
  assert.equal(unknownRepo.status, 409);
  assert.match(errorOf(unknownRepo), new RegExp(`third is not a Studio repo; the Studio repos are first \\(${firstRepo.repoKey}\\), second \\(${secondRepo.repoKey}\\)`));
  assert.match(errorOf(await spawn(orchestrator, { prompt: 'fix the parts', repo: 'second', about: 'nowhere' })), /nowhere is not a folder, module or file on the code map of second/);

  budgetHoldReason = 'the daily budget is spent';
  const held = await spawn(orchestrator, { prompt: 'fix the parts', repo: 'second', about: 'lib' });
  assert.equal(held.status, 429, 'a budget hold stops the Orchestrator like any agent');
  assert.equal(createdProjects.length, 1);
  budgetHoldReason = null;
  const started = await spawn(orchestrator, { prompt: 'fix the parts', repo: 'second', about: 'lib' });
  assert.equal(started.status, 200, errorOf(started));
  const secondBranch = sessions.get(String((started.body as { sessionId?: string }).sessionId));
  assert.ok(secondBranch);
  assert.equal(secondBranch.path, secondRepoDir, 'the branch runs in the repo the Orchestrator named');
  assert.equal(secondBranch.parent?.sessionId, orchestrator.id);
  assert.equal(secondBranch.parent?.box?.title, 'lib');
  assert.ok(secondBranch.parent?.box?.id.startsWith(repoIdPrefixOf(CODEMAP_ID_PREFIXES.map, secondRepo.repoKey)), 'the branch sits on a box of that repo area');
  assert.equal(createdProjects.at(-1)?.startSha, undefined, 'a branch starts from its repo integration branch, not from a pinned commit');
  assert.match(secondBranch.chatOutboxEntries[0]?.text ?? '', /^You are a branch of the session Orchestrator, working in second on lib\. .* The operator asks: fix the parts$/);

  assert.match(errorOf(await spawn(orchestrator, { prompt: 'more parts', repo: secondRepo.repoKey, about: 'lib/part3.ts' })), /already works on lib in second/);
  const byFile = await spawn(orchestrator, { prompt: 'fix a part', repo: firstRepo.repoKey, about: 'lib/part3.ts' });
  assert.equal(byFile.status, 200, 'the same folder name in another repo is free');
  assert.equal(sessions.get(String((byFile.body as { sessionId?: string }).sessionId))?.path, firstRepoDir);

  const appBoxId = (await codemap.branchTargetOf(secondRepoDir, { repoPath: 'app' }));
  assert.ok(appBoxId.ok);
  const fromBoard = await branches.spawn({ orchestratorId: orchestrator.id, place: { boxId: appBoxId.boxId }, prompt: 'tidy the screens' });
  assert.ok(fromBoard.ok);
  assert.equal(sessions.get(fromBoard.sessionId)?.path, secondRepoDir, 'a box on the board names its own repo');

  const overCap = await spawn(orchestrator, { prompt: 'tidy more screens', repo: 'first', about: 'app' });
  assert.equal(overCap.status, 429);
  assert.match(errorOf(overCap), /at most 3 branches may be live at once, and 3 are/);
  assert.equal((await spawn(secondBranch, { prompt: 'help me' })).status, 403, 'a branch starts no session');
  const focusSession = new Session({ id: 'focus', name: 'focus', path: firstRepoDir, ptySpawn: () => fakePty() });
  sessions.set(focusSession.id, focusSession);
  assert.equal((await spawn(focusSession, { prompt: 'help me', repo: 'second', about: 'lib' })).status, 400, 'only the Orchestrator places a session by repo and box');
  assert.equal((await branches.spawn({ orchestratorId: focusSession.id, place: { boxId: appBoxId.boxId }, prompt: 'tidy' })).ok, false);
  for (const session of sessions.values()) session.destroy();
});

test('the sandbox of the Orchestrator lets it write its Studio home and read a repo, and gives it no write access to any repo', () => {
  const root = path.join(os.tmpdir(), 'studio-orchestrator-policy');
  const glimmervoidHome = path.join(root, 'home', '.glimmervoid');
  const studioHome = path.join(glimmervoidHome, 'studio-home');
  const repoDir = path.join(root, 'projects', 'first');
  const { filesystem } = buildSrtSettings({
    homeDir: path.join(root, 'home'),
    glimmervoidHome,
    configFolder: glimmervoidHome,
    secretPaths: [],
    agent: 'claude-code',
    accountFolder: null,
    sealedLoginHomes: [],
    sealedLoginHomeCarveOuts: [],
    userId: os.userInfo().uid,
    worktree: studioHome,
    gitRepositories: [],
    sessionTempFolder: path.join(glimmervoidHome, 'session-temp'),
    readableFiles: [],
    extraAllowedHosts: [],
    enableWeakerNetworkIsolation: false,
    credentialProxy: null,
    hiddenFolders: [studioHome],
    ownFolders: [],
  });
  const isInside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
  assert.ok(filesystem.allowRead.includes(studioHome), 'its own folder is readable though the Glimmervoid home around it is not');
  assert.ok(filesystem.allowWrite.includes(studioHome));
  assert.equal(filesystem.denyRead.some((denied) => isInside(denied, repoDir)), false, 'no read rule hides a repo');
  assert.equal(filesystem.allowWrite.some((allowed) => isInside(allowed, repoDir) || isInside(repoDir, allowed)), false, 'no write rule reaches a repo');
});

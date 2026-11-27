import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../server/config-store.ts';
import { createControlContext } from '../server/control/control-context.ts';
import { createSettingsHandlers } from '../server/control/handlers/settings-handlers.ts';
import { ORCHESTRATOR_NAME, ORCHESTRATOR_RUN_SETTINGS } from '../server/core/studio-main-core.ts';
import { createSessionFactory } from '../server/session/session-factory.ts';
import { SESSION_DRIVER_EVENTS } from '../session/drivers/driver.ts';
import type { Session } from '../session/sessions.ts';

const REPLAY_AGENT_PATH = path.resolve(import.meta.dirname, 'fixtures', 'acp-replay-agent.ts');
const CLAUDE_SETUP_RECORDING = path.resolve(import.meta.dirname, '..', 'harness', 'acp-spike', 'recordings', 'claude', 'setup.jsonl');

function waitForEvent<T>(session: Session, eventName: string, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${eventName}`)), timeoutMs);
    session.once(eventName, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('Studio spawns land on the ACP driver through the real session factory, refuse non-ACP agents, preserve persisted PTY Studio resume, and list only ACP rows for the Studio picker', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-acp-driver-'));
  const studioHome = path.join(tmpDir, 'studio-home');
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(studioHome, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  const config: GlimmervoidConfig = {
    ...DEFAULT_CONFIG,
    projects: [],
    acpAgents: [
      {
        id: 'replay-acp',
        label: 'Replay ACP',
        command: process.execPath,
        args: [REPLAY_AGENT_PATH, CLAUDE_SETUP_RECORDING, '1', 'test@example.com', 'test-plan'],
      },
    ],
  };
  const makeSession = createSessionFactory({
    configStore: { configPath },
    getConfig: () => config,
    hookRouter: null,
    getHookPort: () => null,
    getGitWorkspace: () => null,
    resolveHookTools: () => [],
    getUserHooks: () => [],
  });
  const sessions = new Map<string, Session>();
  let nextId = 1;
  const controlContext = createControlContext({
    sessions,
    config,
    configStore: {
      configPath,
      config,
      save: (mutate: (cfg: GlimmervoidConfig) => void) => {
        mutate(config);
        return config;
      },
    } as never,
    generateProjectId: () => `session-${nextId++}`,
    applyConfigReload: (freshConfig: GlimmervoidConfig) => {
      for (const project of freshConfig.projects) {
        if (sessions.has(project.id)) continue;
        sessions.set(project.id, makeSession(project, freshConfig));
      }
    },
  } as never);

  const refusedOrchestrator = controlContext.createProjectSession({
    name: ORCHESTRATOR_NAME,
    path: studioHome,
    agent: 'kimi',
    requireExistingPath: true,
    runSettings: { ...ORCHESTRATOR_RUN_SETTINGS },
  });
  assert.equal(refusedOrchestrator.ok, false);
  assert.match(refusedOrchestrator.error, /kimi.*no ACP row/i);
  assert.match(refusedOrchestrator.error, /Claude Code \(claude-code\)/);
  assert.match(refusedOrchestrator.error, /Codex CLI \(codex\)/);
  assert.match(refusedOrchestrator.error, /Antigravity \(antigravity\)/);
  assert.match(refusedOrchestrator.error, /Replay ACP \(replay-acp\)/);

  const createdOrchestrator = controlContext.createProjectSession({
    name: ORCHESTRATOR_NAME,
    path: studioHome,
    agent: 'replay-acp',
    requireExistingPath: true,
    runSettings: { ...ORCHESTRATOR_RUN_SETTINGS },
  });
  assert.equal(createdOrchestrator.ok, true);
  assert.equal(createdOrchestrator.project.driverKind, 'acp');
  const orchestrator = sessions.get(createdOrchestrator.project.id);
  assert.ok(orchestrator);
  assert.equal(orchestrator.hasTerminal, false);
  assert.equal(orchestrator.agentId, 'replay-acp');

  const agentSessionPromise = waitForEvent<{ agentSessionId: string; isResumed: boolean }>(orchestrator, SESSION_DRIVER_EVENTS.agentSession);
  await orchestrator.start();
  const opened = await agentSessionPromise;
  assert.ok(opened.agentSessionId.length > 0);
  assert.equal(opened.isResumed, false);
  orchestrator.destroy();

  const createdBranch = controlContext.createProjectSession({
    name: 'repo lib',
    path: repoDir,
    agent: 'antigravity',
    requireExistingPath: true,
    runSettings: { parent: { sessionId: orchestrator.id, box: { id: 'box-1', title: 'lib', repoName: 'repo' } } },
  });
  assert.equal(createdBranch.ok, true);
  assert.equal(createdBranch.project.driverKind, 'acp');
  const branch = sessions.get(createdBranch.project.id);
  assert.ok(branch);
  assert.equal(branch.hasTerminal, false);
  assert.equal(branch.agentId, 'antigravity');
  branch.destroy();

  const focusSession = makeSession({ id: 'focus-1', name: 'Focus', path: repoDir, agent: 'kimi' }, config);
  assert.equal(focusSession.hasTerminal, true);
  focusSession.destroy();

  const legacyStudioProject: ProjectEntry = {
    id: 'legacy-studio-1',
    name: ORCHESTRATOR_NAME,
    path: studioHome,
    agent: 'claude-code',
    isStudioMain: true,
    studioRole: 'orchestrator',
    resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
  };
  const legacyStudioSession = makeSession(legacyStudioProject, config);
  assert.equal(legacyStudioSession.hasTerminal, false, 'a Studio project loads on ACP even without persisted driverKind');
  legacyStudioSession.destroy();

  const nonAcpStudioSession = makeSession({ ...legacyStudioProject, id: 'non-acp-studio-1', agent: 'kimi' }, config);
  assert.equal(nonAcpStudioSession.hasTerminal, false, 'a Studio project whose agent has no ACP row never falls back to PTY');
  assert.equal(nonAcpStudioSession.agentId, 'kimi', 'a Studio project with no ACP row keeps its agent unchanged');
  await nonAcpStudioSession.start();
  assert.equal(nonAcpStudioSession.state, 'DORMANT', 'a Studio project with no ACP row stays stopped even if start() is called');
  nonAcpStudioSession.destroy();

  const persistedAcpSession = makeSession({ ...legacyStudioProject, id: 'acp-studio-1', driverKind: 'acp' }, config);
  assert.equal(persistedAcpSession.hasTerminal, false, 'a persisted ACP Studio session stays on ACP across restart or model switch');
  persistedAcpSession.destroy();

  const settingsHandlers = createSettingsHandlers(controlContext, { config, configStore: { configPath, config } } as never);
  const sentFrames: Record<string, unknown>[] = [];
  const fakeSocket = { send: (payload: string) => { sentFrames.push(JSON.parse(payload)); } } as never;
  const listAgentsHandler = settingsHandlers.handlers['list-agents'];
  assert.ok(listAgentsHandler);
  listAgentsHandler({ type: 'list-agents', requestId: 'req-acp', driver: 'acp' }, fakeSocket);
  const acpReply = sentFrames.at(-1) as { agents: { id: string; resolvable: boolean }[] };
  assert.deepEqual(acpReply.agents.map((agent) => agent.id), ['claude-code', 'codex', 'antigravity', 'replay-acp']);
  assert.equal(acpReply.agents.find((agent) => agent.id === 'replay-acp')?.resolvable, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

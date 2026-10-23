import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import type { ProjectEntry } from '../server/config-store.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/core/control-replay-core.ts';
import { createRemoteSetupWiring } from '../server/remote-setup-wiring.ts';
import type { SessionSpawnOverrides } from '../server/session/session-factory.ts';

test('the remote setup session starts unguarded in its own folder holding the shipped skill, and the folder is removed when the session exits', async () => {
  const setupRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-setup-test-'));
  const skillSourceDir = path.join(import.meta.dirname, '..', 'session', 'remote-setup');
  const broadcasts: ControlMessageRecord[] = [];
  const spawnedProjects: Array<{ project: ProjectEntry; overrides: SessionSpawnOverrides | undefined; hadSkillAtSpawn: boolean }> = [];
  let firePtyExit = () => {};
  const agentSessions = new Map<string, Session>();
  const remoteSetup = createRemoteSetupWiring({
    config: DEFAULT_CONFIG,
    agentSessions,
    makeSession: (project, _config, overrides) => {
      spawnedProjects.push({ project, overrides, hadSkillAtSpawn: fs.existsSync(path.join(project.path, 'SKILL.md')) });
      return new Session({
        id: project.id,
        name: project.name,
        path: project.path,
        spawnCommand: { path: process.execPath, kind: 'exe' },
        ptySpawn: () => ({
          pid: 2147483646,
          onData() {},
          onExit(listener: (event: { exitCode: number }) => void) { firePtyExit = () => listener({ exitCode: 0 }); },
          write() {},
          resize() {},
          kill() {},
        }),
      });
    },
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    broadcastControl: (message) => { broadcasts.push(message); },
    spawnGate: { run: (task) => Promise.resolve(task()) },
    setupRootDir,
    skillSourceDir,
  });
  try {
    const outcome = await remoteSetup.start('codex');
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const [spawned] = spawnedProjects;
    assert.equal(spawned.project.unguarded, true);
    assert.equal(spawned.project.dangerouslySkipPermissions, false);
    assert.equal(spawned.overrides?.agent, 'codex');
    assert.equal(spawned.overrides?.dangerouslySkipPermissions, false);
    assert.equal(spawned.overrides?.gitWorkspace, null);
    assert.match(spawned.overrides?.initialPrompt ?? '', /SKILL\.md/);
    assert.equal(spawned.hadSkillAtSpawn, true);
    assert.ok(fs.existsSync(path.join(spawned.project.path, 'glimmervoid.service')));
    assert.equal(path.dirname(spawned.project.path), setupRootDir);
    assert.ok(broadcasts.some((message) => message.type === 'session-added'));

    firePtyExit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(spawned.project.path), false);
    assert.ok(broadcasts.some((message) => message.type === 'session-removed'));
  } finally {
    for (const session of agentSessions.values()) session.destroy();
    fs.rmSync(setupRootDir, { recursive: true, force: true });
  }
});

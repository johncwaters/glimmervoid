import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { projectSessionCard } from '../session/core/snapshot-projection.ts';
import type { Session } from '../session/sessions.ts';
import { errorMessage } from '../shared/text.ts';
import type { GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord } from './core/control-replay-core.ts';
import { registerEphemeralSession } from './lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './lanes/ephemeral-session.ts';
import type { SessionSpawnOverrides } from './session/session-factory.ts';

const REMOTE_SETUP_TAG = 'remote-setup';
const REMOTE_SETUP_SESSION_NAME = 'Remote host setup';
const REMOTE_SETUP_PROMPT = 'Set up a remote host for Glimmervoid. Read ./SKILL.md in this folder first and follow it; ./glimmervoid.service is the unit template it refers to. Start by asking me the questions its Ground rules list.';

type RemoteSetupAgent = 'claude-code' | 'codex';
type RemoteSetupOutcome = { ok: true; sessionId: string; sessionName: string } | { ok: false; error: string };

interface RemoteSetupWiringOptions {
  config: GlimmervoidConfig;
  agentSessions: Map<string, Session>;
  makeSession: (project: ProjectEntry, config: GlimmervoidConfig, overrides?: SessionSpawnOverrides) => Session;
  wireSessionEvents: (session: Session) => void;
  closeSessionDataClients: (id: string) => void;
  broadcastControl: (message: ControlMessageRecord) => void;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  setupRootDir: string;
  skillSourceDir: string;
}

function createRemoteSetupWiring({
  config, agentSessions, makeSession, wireSessionEvents, closeSessionDataClients, broadcastControl, spawnGate, recordLane = null, setupRootDir, skillSourceDir,
}: RemoteSetupWiringOptions) {
  async function start(agent: RemoteSetupAgent): Promise<RemoteSetupOutcome> {
    const id = `${REMOTE_SETUP_TAG}-${crypto.randomUUID()}`;
    const setupDir = path.join(setupRootDir, id);
    const removeSetupDir = () => fs.promises.rm(setupDir, { recursive: true, force: true }).catch((error: unknown) => {
      console.warn(`[${REMOTE_SETUP_TAG}] could not remove ${setupDir}: ${errorMessage(error)}`);
    });
    let session: Session | null = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      broadcastControl({ type: 'session-removed', id, session: REMOTE_SETUP_SESSION_NAME });
      void removeSetupDir();
    };
    try {
      await fs.promises.cp(skillSourceDir, setupDir, { recursive: true });
      const project: ProjectEntry = { id, name: REMOTE_SETUP_SESSION_NAME, path: setupDir, dangerouslySkipPermissions: false, unguarded: true };
      session = makeSession(project, config, { agent, ephemeral: true, gitWorkspace: null, dangerouslySkipPermissions: false, initialPrompt: REMOTE_SETUP_PROMPT });
      const startedSession = session;
      wireSessionEvents(startedSession);
      registerEphemeralSession({
        map: agentSessions, id, sess: startedSession, closeSessionDataClients, logPrefix: REMOTE_SETUP_TAG, name: REMOTE_SETUP_SESSION_NAME, recordLane,
      });
      startedSession.on('exit', release);
      startedSession.on('teardown', release);
      await spawnGate.run(() => {
        if (startedSession._destroyed) return undefined;
        broadcastControl({ type: 'session-added', ...projectSessionCard(startedSession, { id, name: REMOTE_SETUP_SESSION_NAME }) });
        return startedSession.start();
      });
      if (!startedSession.hasLivePty) throw new Error('the session never reached a live terminal');
      return { ok: true, sessionId: id, sessionName: REMOTE_SETUP_SESSION_NAME };
    } catch (error) {
      session?.destroy();
      release();
      return { ok: false, error: `Could not start the remote setup session: ${errorMessage(error)}` };
    }
  }

  return { start };
}

export { createRemoteSetupWiring };
export type { RemoteSetupAgent, RemoteSetupOutcome };

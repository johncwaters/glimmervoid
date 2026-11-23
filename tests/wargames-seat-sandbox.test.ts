import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSrtSettings } from '../server/sandbox/core/sandbox-policy-core.ts';

function seatSettings(root: string, hiddenFolders: readonly string[], ownFolders: readonly string[] = []) {
  const glimmervoidHome = path.join(root, 'home', '.glimmervoid');
  return buildSrtSettings({
    homeDir: path.join(root, 'home'),
    glimmervoidHome,
    configFolder: glimmervoidHome,
    secretPaths: [],
    agent: 'claude-code',
    accountFolder: null,
    sealedLoginHomes: [],
    sealedLoginHomeCarveOuts: [],
    userId: os.userInfo().uid,
    worktree: path.join(root, 'seats', 'wg-1', 's1'),
    gitRepositories: [],
    sessionTempFolder: path.join(glimmervoidHome, 'session-temp'),
    readableFiles: [],
    extraAllowedHosts: [],
    enableWeakerNetworkIsolation: false,
    credentialProxy: null,
    hiddenFolders,
    ownFolders,
  });
}

test('a Wargames seat sandbox denies the whole seat root and the Glimmervoid home, and re-allows only its own seat folder', () => {
  const root = path.join(os.tmpdir(), 'wargames-seat-policy');
  const seatRoot = path.join(root, 'seats');
  const ownSeatFolder = path.join(seatRoot, 'wg-1', 's1');

  const seat = seatSettings(root, [seatRoot]).filesystem;
  assert.ok(seat.denyRead.includes(seatRoot));
  assert.ok(seat.denyRead.includes(path.join(root, 'home', '.glimmervoid')));
  assert.ok(seat.allowRead.includes(ownSeatFolder));
  assert.ok(seat.allowWrite.includes(ownSeatFolder));
  assert.equal(seat.allowRead.some((allowed) => allowed.startsWith(seatRoot) && allowed !== ownSeatFolder), false);

  const ordinarySession = seatSettings(root, []).filesystem;
  assert.equal(ordinarySession.denyRead.includes(seatRoot), false);
  assert.equal(ordinarySession.allowRead.includes(ownSeatFolder), false);

  const sharedHomes = path.join(root, 'home', '.glimmervoid', 'agent-homes', 'claude', 'sandboxed');
  const ownHome = path.join(sharedHomes, 'private-seat-one');
  const withPrivateHome = seatSettings(root, [seatRoot, sharedHomes], [ownHome]).filesystem;
  assert.ok(withPrivateHome.denyRead.includes(sharedHomes));
  assert.ok(withPrivateHome.allowRead.includes(ownHome));
  assert.ok(withPrivateHome.allowWrite.includes(ownHome));
});

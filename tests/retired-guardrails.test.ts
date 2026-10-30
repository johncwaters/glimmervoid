import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { deleteRetiredGuardrailsFolders } from '../server/session-temp/retired-guardrails.ts';

const sharedTestHome = process.env.GLIMMERVOID_HOME;
let privateRoot = '';

before(async () => {
  assert.ok(sharedTestHome, 'isolate-home must set GLIMMERVOID_HOME');
  privateRoot = await realpath(await mkdtemp(path.join(sharedTestHome, 'retired-guardrails-')));
});

after(async () => {
  await rm(privateRoot, { recursive: true, force: true });
});

const isPresent = (candidate: string) => stat(candidate).then(() => true, () => false);

async function leftoverLaunch(label: string, ownerPid: number) {
  const glimmervoidHome = path.join(privateRoot, label, 'home');
  const worktree = path.join(privateRoot, label, 'worktree');
  const storedLogin = path.join(glimmervoidHome, 'agent-logins', 'claude', '.credentials.json');
  const launchLogin = path.join(glimmervoidHome, 'guardrails-homes', 'launch1', '.claude', '.credentials.json');
  const placeholder = path.join(worktree, '.bashrc');
  await mkdir(path.dirname(storedLogin), { recursive: true });
  await mkdir(path.dirname(launchLogin), { recursive: true });
  await mkdir(path.join(glimmervoidHome, 'guardrails-policies'), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(storedLogin, 'rotated-away-token');
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(storedLogin, anHourAgo, anHourAgo);
  await writeFile(launchLogin, 'refreshed-token');
  await writeFile(placeholder, '');
  const owner = { ownerPid, ownerHost: os.hostname(), ownerPidNamespace: await readlink('/proc/self/ns/pid').catch(() => null), ownsTempDir: false, logins: [{ linkPath: launchLogin, targetPath: storedLogin }], placeholderPaths: [placeholder] };
  await writeFile(path.join(glimmervoidHome, 'guardrails-policies', 'launch1.owner.json'), JSON.stringify(owner));
  return { glimmervoidHome, storedLogin, placeholder };
}

test('retiring the guardrails folders keeps a login refreshed inside a crashed launch and removes its worktree placeholders', async () => {
  const launch = await leftoverLaunch('crashed', 999_999);
  await deleteRetiredGuardrailsFolders(launch.glimmervoidHome, { warn: () => {} });
  assert.equal(await readFile(launch.storedLogin, 'utf8'), 'refreshed-token');
  assert.equal(await isPresent(launch.placeholder), false);
  assert.equal(await isPresent(path.join(launch.glimmervoidHome, 'guardrails-homes')), false);
  assert.equal(await isPresent(path.join(launch.glimmervoidHome, 'guardrails-policies')), false);
});

test('retiring the guardrails folders keeps them while a Glimmervoid process that owns a launch still runs', async () => {
  const launch = await leftoverLaunch('live', process.pid);
  const warnings: string[] = [];
  await deleteRetiredGuardrailsFolders(launch.glimmervoidHome, { warn: (line: string) => warnings.push(line) });
  assert.equal(await readFile(launch.storedLogin, 'utf8'), 'rotated-away-token');
  assert.equal(await isPresent(path.join(launch.glimmervoidHome, 'guardrails-homes')), true);
  assert.equal(warnings.length, 1);
});

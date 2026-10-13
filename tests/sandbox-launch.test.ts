import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import pty from 'node-pty';
import { glimmervoidHomeDir } from '../server/config-store.ts';
import { workRole } from '../server/core/sandbox-roles-core.ts';
import { prepareSandboxLaunch } from '../server/sandbox-launch.ts';

async function launchLockedCheckout(checkout: string, launchId: string) {
  const prepared = await prepareSandboxLaunch({ role: workRole({ vendor: 'claude', cwd: checkout, checkout, agentSessionId: null, readablePaths: [] }), launchId });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
  return prepared.launch;
}

test('a locked checkout with a project .claude folder gets the runtime deny mount points created for the launch and left in place after', async (context) => {
  const factoryFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'factory-'));
  context.after(() => rm(factoryFolder, { recursive: true, force: true }));
  const checkout = path.join(factoryFolder, 'repo');
  await mkdir(path.join(checkout, '.claude'), { recursive: true });
  await writeFile(path.join(checkout, '.claude', 'release-profile.json'), '{}\n');
  const bareCheckout = path.join(factoryFolder, 'bare');
  await mkdir(bareCheckout);

  const launch = await launchLockedCheckout(checkout, 'locked-claude-launch');
  await launch.wrap('/bin/true', [], { hasTerminal: false });
  assert.deepEqual((await readdir(path.join(checkout, '.claude'))).sort(), ['agents', 'commands', 'release-profile.json']);
  await launch.dispose();
  assert.deepEqual((await readdir(path.join(checkout, '.claude'))).sort(), ['agents', 'commands', 'release-profile.json']);

  const bareLaunch = await launchLockedCheckout(bareCheckout, 'locked-bare-launch');
  await bareLaunch.wrap('/bin/true', [], { hasTerminal: false });
  assert.deepEqual(await readdir(bareCheckout), []);
  await bareLaunch.dispose();
});

test('a sandboxed terminal launch can switch its own terminal to raw mode but cannot reach another terminal', { skip: process.platform !== 'darwin' }, async (context) => {
  const launchFolder = await mkdtemp(path.join(glimmervoidHomeDir(), 'terminal-'));
  context.after(() => rm(launchFolder, { recursive: true, force: true }));
  const checkout = path.join(launchFolder, 'repo');
  await mkdir(checkout);
  const launch = await launchLockedCheckout(checkout, 'terminal-launch');
  context.after(() => launch.dispose());

  const siblingTerminal = pty.spawn('/bin/sh', ['-c', 'tty; sleep 30'], { cols: 80, rows: 24 });
  context.after(() => siblingTerminal.kill());
  let siblingOutput = '';
  siblingTerminal.onData((chunk) => { siblingOutput += chunk; });
  const siblingPath = await new Promise<string>((resolve) => {
    const poll = setInterval(() => {
      const siblingName = /\/dev\/ttys\d+/.exec(siblingOutput)?.[0];
      if (siblingName === undefined) return;
      clearInterval(poll);
      resolve(siblingName);
    }, 20);
  });

  const script = `stty -icanon -echo && echo raw-mode-set; (printf x > ${siblingPath}) 2>/dev/null && echo sibling-reached || echo sibling-denied`;
  const wrapped = await launch.wrap('/bin/sh', ['-c', script], { hasTerminal: true });
  const terminal = pty.spawn(wrapped.file, wrapped.args, { cols: 80, rows: 24, cwd: checkout, env: { ...process.env, ...launch.env } });
  let output = '';
  terminal.onData((chunk) => { output += chunk; });
  await new Promise((resolve) => terminal.onExit(resolve));
  assert.match(output, /raw-mode-set/, output);
  assert.match(output, /sibling-denied/, output);
});

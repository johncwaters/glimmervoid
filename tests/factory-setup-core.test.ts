import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyFactorySetupCheck, decideFactorySetupProof, detectFactorySetup } from '../server/factory/core/factory-setup-core.ts';

test('setup detects the repository scripts and package-manager runner commands while preserving global checks', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const repository = detectFactorySetup({
    scripts: manifest.scripts,
    lockfiles: ['package-lock.json'], dependencies: Object.keys(manifest.devDependencies),
  });
  assert.deepEqual(repository.checks, ['npm run typecheck', 'npm run lint', 'npm test']);
  assert.deepEqual(repository.focusedTestCommandCandidates, ['npm run test:files']);
  const vitest = { scripts: { typecheck: 'tsc', test: 'vitest run' }, lockfiles: ['pnpm-lock.yaml'], dependencies: ['vitest'] };
  assert.deepEqual(detectFactorySetup(vitest).checks, ['pnpm run typecheck', 'pnpm run test']);
  assert.deepEqual(detectFactorySetup(vitest).focusedTestCommandCandidates, ['npx vitest run']);
  assert.deepEqual(detectFactorySetup({ ...vitest, globalChecks: ['custom-check'] }).checks, ['custom-check']);
  assert.deepEqual(detectFactorySetup({ scripts: null, lockfiles: [], dependencies: [] }).checks, []);
});

test('proof leaves unproven fields unset and accepts failures at base', () => {
  const proposal = detectFactorySetup({ scripts: { lint: 'lint', test: 'test', 'test:files': 'test' }, lockfiles: [], dependencies: ['jest'] });
  const fullChecks = [
    classifyFactorySetupCheck({ command: 'npm run lint', pass: false, output: 'spawn npm ENOENT' }),
    classifyFactorySetupCheck({ command: 'npm test', pass: false, output: 'not ok 1 - existing regression' }),
  ];
  const focusedChecks = [{ command: 'npm run test:files', pass: false }, { command: 'npx jest', pass: true }];
  const proven = decideFactorySetupProof(proposal, fullChecks, focusedChecks);
  assert.equal(proven.ok, true);
  if (!proven.ok) return;
  assert.deepEqual(proven.profile.checks, ['npm test']);
  assert.equal(proven.profile.focusedTestCommand, 'npx jest');
  assert.deepEqual(proven.profile.widenableScopes, proposal.widenableScopes);
  const withoutFocus = decideFactorySetupProof(proposal, fullChecks, []);
  assert.equal(withoutFocus.ok, true);
  if (!withoutFocus.ok) return;
  assert.equal(Object.hasOwn(withoutFocus.profile, 'focusedTestCommand'), false);
  const fullyProven = decideFactorySetupProof(proposal, [fullChecks[1], classifyFactorySetupCheck({ command: 'npm run lint', pass: true, output: '' })], focusedChecks);
  assert.equal(fullyProven.ok, true);
  if (!fullyProven.ok) return;
  assert.deepEqual(fullyProven.profile.checks, proposal.checks);
  for (const output of [
    "Command failed: npm test\nnot ok 1 - reads a fixture\n  error: 'ENOENT: no such file or directory'",
    "Command failed: npm test\nnot ok 1 - fetches the user\n  error: 'request failed with 404: Not Found'",
  ]) assert.equal(classifyFactorySetupCheck({ command: 'npm test', pass: false, output }).status, 'ran');
});

test('setup refuses only when no full check can run and retains the execution failure reason', () => {
  const proposal = detectFactorySetup({ scripts: { test: 'test' }, lockfiles: [], dependencies: [] });
  for (const output of ['Missing script: "test"', 'sh: test-runner: not found', 'Command failed: npm test\n/bin/sh: 1: test-runner: not found', 'bash: test-runner: command not found', 'spawn npm EACCES', 'Command "test" not found.', 'Check command contains shell syntax or is empty']) {
    const check = classifyFactorySetupCheck({ command: 'npm test', pass: false, output });
    const outcome = decideFactorySetupProof(proposal, [check], [{ command: 'node --test', pass: true }]);
    assert.equal(outcome.ok, false);
    if (outcome.ok) continue;
    assert.ok(outcome.reason.includes(output));
  }
  assert.equal(decideFactorySetupProof(proposal, [], []).ok, false);
});

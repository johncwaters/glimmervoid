import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { execFileAsync } from '../server/child-process-safe.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const handRunDirectory = path.join(repoRoot, 'test');
const backendEntrySpecifier = String.raw`(?:[./]*server\/(?:backend|main|index)\.ts|vite)`;
const bootsBackendThroughStaticImport = new RegExp(String.raw`^import\s+(?!type\b)[^;]*?['"]${backendEntrySpecifier}['"]`, 'm');
const bootsBackendThroughDynamicImport = new RegExp(String.raw`import\(\s*['"]${backendEntrySpecifier}['"]\s*\)`);
const importsTelemetryKillSwitch = /^import\s+['"][./]*(?:support\/)?disable-telemetry\.ts['"]/m;

function handRunSourceFiles(): string[] {
  return fs.readdirSync(handRunDirectory, { recursive: true, encoding: 'utf8' })
    .filter((relativePath) => relativePath.endsWith('.ts'))
    .map((relativePath) => path.join(handRunDirectory, relativePath));
}

test('every hand-run harness that boots a backend turns telemetry off first', () => {
  const backendBooters = handRunSourceFiles().filter((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return bootsBackendThroughStaticImport.test(source) || bootsBackendThroughDynamicImport.test(source);
  });
  assert.ok(backendBooters.length >= 5, `expected the known harnesses, found ${backendBooters.length}`);
  const unguarded = backendBooters
    .filter((filePath) => !importsTelemetryKillSwitch.test(fs.readFileSync(filePath, 'utf8')))
    .map((filePath) => path.relative(repoRoot, filePath));
  assert.deepEqual(unguarded, []);
});

test('importing the telemetry kill switch turns consent off in a process that had it on', async () => {
  const consentProbe = [
    "await import('./test/support/disable-telemetry.ts');",
    "const { decideTelemetryConsent } = await import('./server/core/telemetry-core.ts');",
    'process.stdout.write(JSON.stringify(decideTelemetryConsent(process.env, {})));',
  ].join(' ');
  const consentEnvironment: NodeJS.ProcessEnv = { PATH: process.env.PATH, GLIMMERVOID_TELEMETRY: '1' };
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', consentProbe], {
    cwd: repoRoot, encoding: 'utf8', env: consentEnvironment, timeout: 20_000,
  });
  assert.deepEqual(JSON.parse(stdout), { isEnabled: false, source: 'environment' });
});

test('the remote-mode container image runs with telemetry off', () => {
  const dockerfile = fs.readFileSync(path.join(handRunDirectory, 'container', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ENV GLIMMERVOID_TELEMETRY=0$/m);
});

test('the node:test preload shares the hand-run telemetry kill switch', () => {
  const preloadSource = fs.readFileSync(path.join(repoRoot, 'tests', 'helpers', 'isolate-home.ts'), 'utf8');
  assert.match(preloadSource, /^import '\.\.\/\.\.\/test\/support\/disable-telemetry\.ts';$/m);
});

test('the site-capture config document keeps telemetry off once the environment is wiped', async () => {
  const consentProbe = [
    "const fs = await import('node:fs/promises');",
    "const os = await import('node:os');",
    "const path = await import('node:path');",
    "const { prepareIsolatedEnvironment } = await import('./test/site-capture/isolated-glimmervoid.ts');",
    "const { decideTelemetryConsent } = await import('./server/core/telemetry-core.ts');",
    "const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-telemetry-probe-'));",
    'try {',
    '  const { configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [], recordSessions: false });',
    "  const configDocument = JSON.parse(await fs.readFile(configPath, 'utf8'));",
    '  process.stdout.write(JSON.stringify(decideTelemetryConsent({}, configDocument)));',
    '} finally {',
    '  await fs.rm(tempDirectory, { recursive: true, force: true });',
    '}',
  ].join(' ');
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', consentProbe], {
    cwd: repoRoot, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20_000,
  });
  assert.deepEqual(JSON.parse(stdout), { isEnabled: false, source: 'config' });
});

test('the browser harness config document keeps telemetry off once the environment is wiped', () => {
  const harnessSource = fs.readFileSync(path.join(handRunDirectory, 'browser', 'harness.ts'), 'utf8');
  const configDocumentSource = harnessSource.match(/const configDocument = \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
  assert.match(configDocumentSource, /^ {4}telemetry: \{ enabled: false \},$/m);
});

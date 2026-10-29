import { execSync } from 'node:child_process';
import type { ExecSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pkg from '../package.json' with { type: 'json' };
import { REPO_SLUG } from '../shared/repo.ts';
import { LATEST_ALIAS_ASSET_NAME, packReleaseTarballs, versionedAssetName } from './pack-release-tarballs.ts';

function run(cmd: string, opts: ExecSyncOptions = {}): void {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function runCapture(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function hasCommand(cmd: string): boolean {
  const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    execSync(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(ancestorRef: string, descendantRef: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestorRef} ${descendantRef}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isNpmLoggedIn(): boolean {
  try {
    execSync('npm whoami', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function deprecateVersionsBelowRelease(): void {
  console.log(`\n==> ${TAG} carries a Security section; deprecating the versions below it on npm...`);
  const deprecationMessage = `Security: versions below ${VERSION} have a known vulnerability. Update to ${VERSION} or later. https://github.com/${REPO_SLUG}/releases/tag/${TAG}`;
  const deprecateCommand = `npm deprecate "glimmervoid@<${VERSION}" "${deprecationMessage}"`;
  if (!isNpmLoggedIn()) {
    console.log('   npm is not logged in here, so nothing was deprecated. Log in as a package owner and run:');
    console.log(`   ${deprecateCommand}`);
    return;
  }
  try {
    run(deprecateCommand);
  } catch {
    console.log('   npm deprecate failed, so the versions below this release are not marked. Run it again as a package owner:');
    console.log(`   ${deprecateCommand}`);
  }
}

function pauseMs(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function findTestRunDispatchedSince(commitSha: string, dispatchedAt: Date): string | null {
  for (let attempt = 0; attempt < TEST_RUN_LOOKUP_ATTEMPTS; attempt++) {
    const listed: { databaseId: number; createdAt: string }[] = JSON.parse(
      runCapture(`gh run list --workflow ${TEST_WORKFLOW} --event workflow_dispatch --commit ${commitSha} --limit 5 --json databaseId,createdAt`),
    );
    const dispatchedRun = listed.find((testRun) => new Date(testRun.createdAt) >= dispatchedAt);
    if (dispatchedRun) return String(dispatchedRun.databaseId);
    pauseMs(TEST_RUN_LOOKUP_INTERVAL_MS);
  }
  return null;
}

function requirePassingTestRun(commitSha: string): void {
  console.log(`\n==> Running ${TEST_WORKFLOW} on ${commitSha} before tagging...`);
  const dispatchedAt = new Date(Date.now() - TEST_RUN_CLOCK_SKEW_MS);
  run(`gh workflow run ${TEST_WORKFLOW} --ref ${RELEASE_BRANCH}`);
  const testRunId = findTestRunDispatchedSince(commitSha, dispatchedAt);
  if (testRunId === null) {
    console.error(`ERROR: no ${TEST_WORKFLOW} run started on ${commitSha}; ${RELEASE_BRANCH} likely moved past it. Nothing was tagged. Rebase onto ${RELEASE_UPSTREAM} and run npm run release again.`);
    process.exit(1);
  }
  try {
    run(`gh run watch ${testRunId} --exit-status --interval 10`);
  } catch {
    console.error(`ERROR: ${TEST_WORKFLOW} run ${testRunId} did not pass on ${commitSha}, so nothing was tagged. Fix ${RELEASE_BRANCH} and run npm run release again.`);
    process.exit(1);
  }
}

function openNextPatch(releasedVersion: string): void {
  const [major, minor, patch] = releasedVersion.split('.').map(Number);
  const upcomingVersion = `${major}.${minor}.${patch + 1}-next.0`;
  console.log(`\n==> Opening ${upcomingVersion} on ${RELEASE_BRANCH}...`);
  run(`npm version ${upcomingVersion} --no-git-tag-version`);
  run(`git commit -m "chore(release): open ${upcomingVersion}" -- package.json package-lock.json`);
  run(`git push origin HEAD:refs/heads/${RELEASE_BRANCH}`);
}

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const RELEASE_BRANCH = 'main';
const RELEASE_UPSTREAM = `origin/${RELEASE_BRANCH}`;
const SECURITY_HEADING = /^### Security\b/m;
const TEST_WORKFLOW = 'test.yml';
const TEST_RUN_LOOKUP_ATTEMPTS = 24;
const TEST_RUN_LOOKUP_INTERVAL_MS = 5000;
const TEST_RUN_CLOCK_SKEW_MS = 60_000;

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const versionEscaped = VERSION.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const releaseSectionPattern = new RegExp(String.raw`^## \[${versionEscaped}\].*\r?\n([\s\S]*?)(?=^## \[|$(?![\r\n]))`, 'm');
const releaseSection = changelog.match(releaseSectionPattern)?.[1].trim() ?? null;

console.log(`==> Releasing glimmervoid ${TAG}\n`);

if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`ERROR: ${VERSION} is not a release version. Set package.json to X.Y.Z (drop the -next.0 suffix) in the release commit first.`);
  process.exit(1);
}

const status = runCapture('git status --porcelain');
if (status) {
  console.error('ERROR: Working tree is dirty. Commit or stash changes first.');
  process.exit(1);
}

run(`git fetch origin ${RELEASE_BRANCH}`);
if (!isAncestor(RELEASE_UPSTREAM, 'HEAD')) {
  console.error(`ERROR: HEAD is behind or has diverged from ${RELEASE_UPSTREAM}. Rebase onto ${RELEASE_UPSTREAM} and re-check before releasing.`);
  process.exit(1);
}

const existingTags = runCapture('git tag -l');
if (existingTags.split('\n').includes(TAG)) {
  console.error(`ERROR: Tag ${TAG} already exists. Bump the version in package.json first.`);
  process.exit(1);
}

if (!hasCommand('gh')) {
  console.error('ERROR: the gh CLI is required: the release waits on a test.yml run before tagging.');
  process.exit(1);
}

console.log('==> Building...');
run('npm run build');
fs.statSync('dist/client/index.html');

console.log('\n==> Checking the tarball contents...');
const NOTICE_LINE = /^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/;
const packedFiles = runCapture('npm pack --dry-run 2>&1')
  .split('\n')
  .map((line) => line.trim().match(NOTICE_LINE))
  .filter((match): match is RegExpMatchArray => match !== null)
  .map((match) => match[1].trim());

if (!packedFiles.includes('dist/bin/glimmervoid.js')) {
  console.error('ERROR: the tarball has no dist/bin/glimmervoid.js, so the installed CLI would have nothing to run.');
  process.exit(1);
}
const rawSources = packedFiles.filter((file) => /\.[cm]?ts$/.test(file));
if (rawSources.length > 0) {
  console.error(`ERROR: the tarball ships raw TypeScript sources: ${rawSources.join(', ')}`);
  process.exit(1);
}
console.log(`   ${packedFiles.length} files, all built.`);

console.log('\n==> Pushing to GitHub...');
run(`git push origin HEAD:refs/heads/${RELEASE_BRANCH}`);

requirePassingTestRun(runCapture('git rev-parse HEAD'));

console.log(`\n==> Tagging ${TAG}...`);
run(`git tag -a ${TAG} -m "Glimmervoid ${TAG}"`);
run(`git push origin ${TAG}`);

console.log('\n==> Creating GitHub release...');
const notes = releaseSection ?? `Release ${TAG}`;

const tmpFile = 'release-notes.tmp.md';
fs.writeFileSync(tmpFile, notes);
const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-release-'));
try {
  console.log('\n==> Packing the release tarballs...');
  const { latestAliasPath, versionedAssetPath } = packReleaseTarballs(packDirectory, VERSION);
  run(`gh release create ${TAG} "${versionedAssetPath}" "${latestAliasPath}" --title "Glimmervoid ${TAG}" --notes-file ${tmpFile}`);
} finally {
  fs.rmSync(packDirectory, { recursive: true, force: true });
  try { fs.unlinkSync(tmpFile); } catch {  }
}

if (releaseSection && SECURITY_HEADING.test(releaseSection)) deprecateVersionsBelowRelease();

openNextPatch(VERSION);

console.log(`\n==> Done! Tagged and pushed glimmervoid ${TAG}, and ${RELEASE_BRANCH} now carries the next patch as an upcoming prerelease.`);
console.log(`   The release carries ${LATEST_ALIAS_ASSET_NAME} and ${versionedAssetName(VERSION)} to keep pre-0.29.1 tarball installs updatable.`);
console.log(`   The tag push triggers .github/workflows/publish.yml, which publishes glimmervoid@${VERSION} to npm. Nothing is published locally.`);
console.log(`   Watch it at https://github.com/${REPO_SLUG}/actions/workflows/publish.yml, then confirm with: npm view glimmervoid@${VERSION} version`);

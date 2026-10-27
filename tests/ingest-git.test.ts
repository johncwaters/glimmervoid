
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitIngest } from '../server/ingest/ingest-git.ts';
import type { GitIngestOptions } from '../server/ingest/ingest-git.ts';
import { createIngestLane } from '../server/ingest/ingest-wiring.ts';
import { resolveIngestConfig } from '../server/ingest/core/ingest-core.ts';
import { LOG_FIELD_SEPARATOR } from '../server/ingest/core/ingest-git-core.ts';
import type { GitIngestEvent } from '../server/ingest/core/ingest-git-core.ts';
import type { WatchDebounce } from '../detection/watch-debounce.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

const GIT = hasGit();
const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
type GitExec = NonNullable<GitIngestOptions['execFileFn']>;

interface FakeTimers {
  delays: { intervals: number[]; timeouts: number[] };
  setIntervalFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn: (handle: NodeJS.Timeout) => void;
  setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  runTimeouts: () => void;
}

interface FakeGit {
  runner: GitExec;
}

interface FakeWatchers {
  watched: string[];
  readonly stopCount: number;
  factory: () => WatchDebounce;
}

function parkedTimer(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 2 ** 30);
  handle.unref();
  return handle;
}

function fakeTimers(): FakeTimers {
  const intervals = new Map<NodeJS.Timeout, () => void>();
  const timeouts = new Map<NodeJS.Timeout, () => void>();
  const delays: { intervals: number[]; timeouts: number[] } = { intervals: [], timeouts: [] };
  return {
    delays,
    setIntervalFn: (fn, ms) => {
      const handle = parkedTimer();
      intervals.set(handle, fn);
      delays.intervals.push(ms);
      return handle;
    },
    clearIntervalFn: (handle) => { clearTimeout(handle); intervals.delete(handle); },
    setTimeoutFn: (fn, ms) => {
      const handle = parkedTimer();
      timeouts.set(handle, fn);
      delays.timeouts.push(ms);
      return handle;
    },
    clearTimeoutFn: (handle) => { clearTimeout(handle); timeouts.delete(handle); },
    runTimeouts: () => {
      const jobs = [...timeouts.values()];
      timeouts.clear();
      for (const fn of jobs) fn();
    },
  };
}

function fakeWatchers(): FakeWatchers {
  const watched: string[] = [];
  const stopped = { count: 0 };
  return {
    watched,
    get stopCount() { return stopped.count; },
    factory: () => {
      let active = false;
      return {
        watch(dir: string) {
          active = true;
          watched.push(dir);
          return true;
        },
        stop() {
          if (active) stopped.count += 1;
          active = false;
        },
        fire() {},
        get active() { return active; },
        get stopped() { return !active; },
      };
    },
  };
}

function gitOf(lane: ReturnType<typeof createIngestLane>) {
  if (!lane.git) throw new Error('the git source is off on this lane');
  return lane.git;
}

const CLEAN_PORCELAIN = `# branch.oid ${SHA}\n# branch.head main\n`;

function logLine(sha: string, subject: string): string {
  return `${[sha, 'Glimmervoid Test', '1699999999', subject].join(LOG_FIELD_SEPARATOR)}\n`;
}

function fakeGit({ status }: { status: () => string }): FakeGit {
  return {
    runner: async (_file, args, options) => {
      if (args[0] === 'rev-parse') {
        const cwd = String(options?.cwd);
        return { stdout: `${cwd}\n${cwd}/.git\n${cwd}/.git\n` };
      }
      if (args.includes('status')) return { stdout: status() };
      return { stdout: logLine(SHA, 'init') };
    },
  };
}

const INJECTED_TIMING = { debounceMs: 1000, pollMs: 60000 };

interface InjectedSourceOptions {
  fake: FakeGit;
  watchers: FakeWatchers;
  timers: FakeTimers;
  published: GitIngestEvent[];
  overrides?: Partial<GitIngestOptions>;
}

function injectedSource({ fake, watchers, timers, published, overrides = {} }: InjectedSourceOptions) {
  return createGitIngest({
    publish: (event) => published.push(event),
    sourceConfig: INJECTED_TIMING,
    reposProvider: () => ['/repo'],
    execFileFn: fake.runner,
    createWatch: watchers.factory,
    canonicalize: (dir) => dir,
    logger: { warn: () => {} },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
}

function initRepo(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try {
    git(['init', '-b', 'main'], dir);
  } catch {
    git(['init'], dir);
  }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glimmervoid Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function initRepoWithCommit(prefix: string): string {
  const dir = initRepo(prefix);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}

async function realSource({ dirs, published, timers, overrides = {} }: {
  dirs: string[];
  published: GitIngestEvent[];
  timers: FakeTimers;
  overrides?: Partial<GitIngestOptions>;
}) {
  const source = createGitIngest({
    publish: (event) => published.push(event),
    sourceConfig: { debounceMs: 1, pollMs: 600000 },
    reposProvider: () => dirs,
    logger: { warn: () => {} },
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
  await source.start();
  return source;
}

async function settleThroughDebounce(source: ReturnType<typeof createGitIngest>, timers: FakeTimers): Promise<void> {
  for (const key of source.repoKeys) source.trigger(key);
  timers.runTimeouts();
  await source.settle();
}

test('a commit publishes one commit event with its branch and subject', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-commit-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  assert.equal(source.repoCount, 1, 'the project checkout is the watch set');
  assert.equal(published.length, 0, 'the first read of a repo is a baseline');
  assert.ok(source.watchCount >= 1, 'a real gitdir watch is installed');

  fs.writeFileSync(path.join(dir, 'feature.txt'), 'work\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'add the feature flag'], dir);

  await settleThroughDebounce(source, timers);

  assert.equal(published.length, 1, `expected exactly one event, got ${JSON.stringify(published)}`);
  const [event] = published;
  assert.equal(event.source, 'git');
  assert.equal(event.kind, 'commit');
  assert.equal(event.scope.root, dir);
  assert.match(event.summary, /^commit [0-9a-f]{7} on main: add the feature flag$/);
  assert.equal(event.detail.branch, 'main');
});

test('touching gitdir files without changing anything publishes nothing', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-noop-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  const gitDir = path.join(dir, '.git');
  const stamp = new Date();
  for (let burst = 0; burst < 5; burst += 1) {
    for (const name of ['HEAD', 'index', 'COMMIT_EDITMSG']) {
      const target = path.join(gitDir, name);
      if (fs.existsSync(target)) fs.utimesSync(target, stamp, stamp);
    }
    for (const key of source.repoKeys) source.trigger(key);
  }
  assert.equal(source.pendingTimerCount, 1);
  timers.runTimeouts();
  await source.settle();

  assert.deepEqual(published, [], 'a no-op trigger storm must publish nothing');
});

test('a working-tree change publishes one status-change, and repeating it publishes nothing', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-status-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'status-change');
  assert.equal(published[0].summary, 'working tree on main: 1 untracked');

  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1, 'an unchanged signature dedupes the second read away');

  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello again\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1, 'the content changed but the signature did not');

  git(['add', '-A'], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 2, 'staging moves the signature');
  assert.equal(published[1].summary, 'working tree on main: 1 staged');
});

test('a branch switch publishes branch-change, and an unborn repo lives through its first commit', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-branch-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  git(['checkout', '-b', 'feature/nested-name'], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'branch-change');
  assert.match(published[0].summary, /^switched to feature\/nested-name at [0-9a-f]{7}: init$/);

  const head = git(['rev-parse', 'HEAD'], dir).trim();
  git(['checkout', '--detach', head], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 2);
  assert.equal(published[1].kind, 'branch-change');
  assert.match(published[1].summary, /^switched to detached HEAD at [0-9a-f]{7}: init$/);
});

test('a repo with no commits baselines, reports its tree, and publishes its first commit', { skip: !GIT }, async (t) => {
  const dir = initRepo('glimmervoid-ingest-git-unborn-');
  t.after(() => cleanup(dir));
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir], published, timers });
  t.after(() => source.stop());

  assert.equal(source.repoCount, 1, 'an unborn repo is still a repo');
  assert.equal(published.length, 0);

  fs.writeFileSync(path.join(dir, 'first.txt'), 'one\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, 'status-change');
  assert.match(published[0].summary, /no commits yet\): 1 untracked$/);

  git(['add', '-A'], dir);
  git(['commit', '-m', 'the first commit'], dir);
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 2);
  assert.equal(published[1].kind, 'commit');
  assert.match(published[1].summary, /^commit [0-9a-f]{7} on main: the first commit$/);
});

test('two candidate directories inside one checkout are one repo, and a subdirectory resolves to it', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-dedupe-');
  t.after(() => cleanup(dir));
  const nested = path.join(dir, 'src');
  fs.mkdirSync(nested, { recursive: true });
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir, nested, dir], published, timers });
  t.after(() => source.stop());

  assert.equal(source.repoCount, 1, 'one gitdir is one repo no matter how many sessions name it');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n', 'utf8');
  await settleThroughDebounce(source, timers);
  assert.equal(published.length, 1);
  assert.equal(published[0].scope.root, dir);
});

test('a linked worktree is its own checkout, and an unnamed one is invisible', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-worktree-');
  const worktreeDir = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  t.after(() => cleanup(dir));
  t.after(() => cleanup(worktreeDir));
  git(['worktree', 'add', worktreeDir, '-b', 'glimmervoid/session'], dir);

  const unnamed: GitIngestEvent[] = [];
  const unnamedTimers = fakeTimers();
  const repoOnly = await realSource({ dirs: [dir], published: unnamed, timers: unnamedTimers });
  const named: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const source = await realSource({ dirs: [dir, worktreeDir], published: named, timers });
  t.after(() => repoOnly.stop());
  t.after(() => source.stop());

  assert.equal(repoOnly.repoCount, 1, 'a worktree nobody named is not in the watch set');
  assert.equal(source.repoCount, 2, 'a named worktree is a checkout of its own, not a second view of one');

  fs.writeFileSync(path.join(worktreeDir, 'in-worktree.txt'), 'work\n', 'utf8');
  git(['add', '-A'], worktreeDir);
  git(['commit', '-m', 'commit inside the worktree'], worktreeDir);

  await settleThroughDebounce(repoOnly, unnamedTimers);
  assert.equal(unnamed.length, 0, 'a commit in an unwatched worktree publishes nothing at all');

  await settleThroughDebounce(source, timers);
  assert.equal(named.length, 1, `expected one event, got ${JSON.stringify(named)}`);
  assert.equal(named[0].kind, 'commit');
  assert.equal(named[0].scope.root, worktreeDir, 'the scope is the worktree, not the repo it forked from');
  assert.match(named[0].summary, /^commit [0-9a-f]{7} on glimmervoid\/session: commit inside the worktree$/);
});

test('the lane publishes git events through the normalizer, and builds them into the digest', { skip: !GIT }, async (t) => {
  const dir = initRepoWithCommit('glimmervoid-ingest-git-lane-');
  t.after(() => cleanup(dir));
  const timers = fakeTimers();
  const lane = createIngestLane({
    config: resolveIngestConfig({
      enabled: true, sources: { git: { enabled: true, debounceMs: 1, pollMs: 600000 } },
    }),
    logger: { warn: () => {} },
    repoRoots: () => [dir],
    ...timers,
  });
  t.after(() => lane.stop());
  assert.equal(lane.gitEnabled, true);
  await gitOf(lane).start();
  assert.equal(timers.delays.intervals.at(-1), 600000, 'the poll interval came from the resolved config');

  fs.writeFileSync(path.join(dir, 'shipped.txt'), 'done\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'ship the git source'], dir);
  await settleThroughDebounce(gitOf(lane), timers);

  const events = lane.recentEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'commit');
  assert.equal(events[0].seq, 1, 'the lane stamps the ordering key, not the adapter');
  assert.equal(lane.latestSeq(), 1);
  assert.match(lane.buildDigest({ scopes: [dir] }), /- git .*: commit [0-9a-f]{7} on main: ship the git source/);
});

test('a missing repository root is dropped after status fails, without retry noise', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const warnings: string[] = [];
  let isMissing = false;
  const fake = fakeGit({
    status: () => {
      if (isMissing) throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      return CLEAN_PORCELAIN;
    },
  });
  const source = injectedSource({
    fake,
    watchers,
    timers,
    published,
    overrides: {
      logger: { log: () => {}, warn: (message) => warnings.push(message) },
      statRepoDir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  });
  await source.start();
  const installed = watchers.watched.length;

  isMissing = true;
  await settleThroughDebounce(source, timers);

  assert.equal(source.repoCount, 0);
  assert.equal(watchers.stopCount, installed);
  assert.equal(warnings.filter((message) => message.includes('retrying')).length, 0);
  assert.equal(warnings.filter((message) => message.includes('dropped missing repository')).length, 1);
  await source.stop();
});

test('a repository whose root vanished is not re-added from the cached layout on every poll', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const notes: string[] = [];
  const warnings: string[] = [];
  let isMissing = false;
  const source = injectedSource({
    fake: fakeGit({ status: () => CLEAN_PORCELAIN }),
    watchers,
    timers,
    published,
    overrides: {
      execFileFn: async (_file, args, options) => {
        if (isMissing) throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
        if (args[0] === 'rev-parse') {
          return { stdout: `${String(options.cwd)}\n${String(options.cwd)}/.git\n${String(options.cwd)}/.git\n` };
        }
        if (args.includes('status')) return { stdout: CLEAN_PORCELAIN };
        return { stdout: logLine(SHA, 'init') };
      },
      logger: { log: (message: string) => notes.push(message), warn: (message: string) => warnings.push(message) },
      statRepoDir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  });
  await source.start();
  assert.equal(source.repoCount, 1);

  isMissing = true;
  await settleThroughDebounce(source, timers);
  assert.equal(source.repoCount, 0);

  for (let poll = 0; poll < 3; poll += 1) {
    await source.poll();
    timers.runTimeouts();
    await source.settle();
  }

  assert.equal(source.repoCount, 0);
  assert.equal(notes.filter((message) => message.includes('git source: added')).length, 1);
  assert.equal(warnings.filter((message) => message.includes('dropped missing repository')).length, 1);
  await source.stop();
});

test('a second directory in the same repository does not re-add it after the root vanished', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const notes: string[] = [];
  const warnings: string[] = [];
  let isMissing = false;
  const source = injectedSource({
    fake: fakeGit({ status: () => CLEAN_PORCELAIN }),
    watchers,
    timers,
    published,
    overrides: {
      reposProvider: () => ['/repo', '/repo/nested'],
      execFileFn: async (_file, args, _options) => {
        if (isMissing) throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
        if (args[0] === 'rev-parse') return { stdout: '/repo\n/repo/.git\n/repo/.git\n' };
        if (args.includes('status')) return { stdout: CLEAN_PORCELAIN };
        return { stdout: logLine(SHA, 'init') };
      },
      logger: { log: (message: string) => notes.push(message), warn: (message: string) => warnings.push(message) },
      statRepoDir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    },
  });
  await source.start();
  assert.equal(source.repoCount, 1);

  isMissing = true;
  await settleThroughDebounce(source, timers);
  assert.equal(source.repoCount, 0);

  for (let poll = 0; poll < 3; poll += 1) {
    await source.poll();
    timers.runTimeouts();
    await source.settle();
  }

  assert.equal(source.repoCount, 0);
  assert.equal(notes.filter((message) => message.includes('git source: added')).length, 1);
  assert.equal(warnings.filter((message) => message.includes('dropped missing repository')).length, 1);
  await source.stop();
});

test('a git binary that vanishes from PATH keeps the repo watched and retries', async () => {
  const published: GitIngestEvent[] = [];
  const timers = fakeTimers();
  const watchers = fakeWatchers();
  const warnings: string[] = [];
  let spawnFails = false;
  const fake = fakeGit({
    status: () => {
      if (spawnFails) throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      return CLEAN_PORCELAIN;
    },
  });
  const statted: string[] = [];
  const source = injectedSource({
    fake,
    watchers,
    timers,
    published,
    overrides: {
      logger: { log: () => {}, warn: (message) => warnings.push(message) },
      statRepoDir: async (dir: string) => {
        statted.push(dir);
        return {};
      },
    },
  });
  await source.start();

  spawnFails = true;
  await settleThroughDebounce(source, timers);
  await settleThroughDebounce(source, timers);

  assert.equal(source.repoCount, 1);
  assert.deepEqual(statted, ['/repo', '/repo']);
  assert.equal(watchers.stopCount, 0);
  assert.equal(warnings.filter((message) => message.includes('dropped missing repository')).length, 0);
  assert.equal(warnings.filter((message) => message.includes('retrying')).length, 1);

  spawnFails = false;
  await settleThroughDebounce(source, timers);
  assert.equal(source.repoCount, 1);
  await source.stop();
});

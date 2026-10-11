import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileAsync } from '../server/child-process-safe.ts';
import { buildFactoryCheckEnv, factoryWrittenRecordId, findForbiddenLedgerWrites } from '../server/core/factory-core.ts';
import { buildHardenedGitInvocation, gitInvocationEnvironment, parseFilterDriverNames } from '../server/core/git-invocation-core.ts';
import { createGitWorkspace, runHardenedGit } from '../server/git-workspace.ts';

const REAL_PROCESS_DEADLINE_MS = 30_000;

const invocationOptions = { baseEnv: { PATH: '/bin', HOME: '/home/test', FACTORY_PROBE_TOKEN: 'secret', GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'malicious', GIT_EXTERNAL_DIFF: 'malicious' }, platform: 'linux', devNullPath: '/dev/null' };

function scopedListing(entries: [scope: string, key: string, value: string | null][]): string {
  return entries.map(([scope, key, value]) => `${scope}\0${value === null ? key : `${key}\n${value}`}\0`).join('');
}

function overridesOf(args: string[]): string[] {
  return args.flatMap((argument, index) => args[index - 1] === '-c' ? [argument] : []);
}

test('hardened git invocation suppresses hooks, fsmonitor, external diff, textconv and every named filter command', () => {
  const invocation = buildHardenedGitInvocation(['diff', 'HEAD'], { ...invocationOptions,
    configListing: scopedListing([['local', 'filter.payload.clean', 'x'], ['local', 'filter.payload.smudge', 'x'], ['local', 'filter.payload.process', 'x'],
      ['local', 'filter.payload.required', 'true'], ['local', 'merge.payload.driver', 'x']]) });
  for (const override of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'diff.external=', 'filter.payload.clean=', 'core.editor=true', 'sequence.editor=true',
    'filter.payload.smudge=', 'filter.payload.process=', 'filter.payload.required=false', 'merge.payload.driver=false']) assert.ok(invocation.args.includes(override), override);
  assert.deepEqual(invocation.args.slice(-4), ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.equal(invocation.env.FACTORY_PROBE_TOKEN, undefined);
  assert.equal(invocation.env.GIT_EXTERNAL_DIFF, undefined);
  assert.equal(invocation.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(invocation.env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(invocation.env.GIT_CONFIG_GLOBAL, undefined);
});

test('hardened git invocation keeps admin-owned system config and passes git transport env through to git only', () => {
  const transportEnv = { SSH_AUTH_SOCK: '/agent.sock', GIT_SSH_COMMAND: 'ssh -i key', GIT_ASKPASS: '/askpass', SSH_ASKPASS: '/ssh-askpass',
    HTTP_PROXY: 'http://proxy', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'localhost', http_proxy: 'http://proxy', https_proxy: 'http://proxy', no_proxy: 'localhost',
    XDG_CONFIG_HOME: '/home/test/.config' };
  const baseEnv = { ...invocationOptions.baseEnv, ...transportEnv };
  const invocation = buildHardenedGitInvocation(['fetch', 'origin'], { ...invocationOptions, baseEnv });
  assert.equal(invocation.env.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(invocation.env.GIT_CONFIG_SYSTEM, undefined);
  for (const [key, value] of Object.entries(transportEnv)) assert.equal(invocation.env[key], value, key);
  const checkEnv = buildFactoryCheckEnv(baseEnv, 'linux');
  for (const key of Object.keys(transportEnv)) assert.equal(checkEnv[key], undefined, key);
});

test('hardened git invocation takes transport env from the server env when a scrubbed base env lacks it, and a base env value wins', () => {
  const transportSourceEnv = { SSH_AUTH_SOCK: '/server-agent.sock', GIT_SSH_COMMAND: 'ssh -i server-key', HTTPS_PROXY: 'http://server-proxy', FACTORY_PROBE_TOKEN: 'server-secret' };
  const scrubbed = buildHardenedGitInvocation(['fetch', 'origin'], { ...invocationOptions, transportSourceEnv });
  assert.equal(scrubbed.env.SSH_AUTH_SOCK, '/server-agent.sock');
  assert.equal(scrubbed.env.GIT_SSH_COMMAND, 'ssh -i server-key');
  assert.equal(scrubbed.env.HTTPS_PROXY, 'http://server-proxy');
  assert.equal(scrubbed.env.FACTORY_PROBE_TOKEN, undefined);
  const explicit = buildHardenedGitInvocation(['fetch', 'origin'], { ...invocationOptions,
    baseEnv: { ...invocationOptions.baseEnv, SSH_AUTH_SOCK: '/caller-agent.sock' }, transportSourceEnv });
  assert.equal(explicit.env.SSH_AUTH_SOCK, '/caller-agent.sock');
});

test('repository-local credential helpers are reset and only system and global helpers are re-added in order', () => {
  const invocation = buildHardenedGitInvocation(['push', 'origin'], { ...invocationOptions, configListing: scopedListing([
    ['system', 'credential.helper', 'osxkeychain'],
    ['global', 'credential.https://github.com.helper', ''],
    ['global', 'credential.https://github.com.helper', '!gh auth git-credential'],
    ['local', 'credential.helper', '!planted-helper'],
    ['worktree', 'credential.https://github.com.helper', '!planted-url-helper'],
  ]) });
  const overrides = overridesOf(invocation.args);
  assert.deepEqual(overrides.filter((override) => override.startsWith('credential.')), [
    'credential.helper=', 'credential.helper=osxkeychain',
    'credential.https://github.com.helper=', 'credential.https://github.com.helper=', 'credential.https://github.com.helper=!gh auth git-credential',
  ]);
  assert.equal(overrides.some((override) => override.includes('planted')), false);
});

test('a repository-local ssh command is overridden by the operator value or plain ssh', () => {
  const plantedOnly = buildHardenedGitInvocation(['fetch'], { ...invocationOptions, configListing: scopedListing([['local', 'core.sshcommand', 'planted']]) });
  assert.ok(overridesOf(plantedOnly.args).includes('core.sshCommand=ssh'));
  const operatorAndPlanted = buildHardenedGitInvocation(['fetch'], { ...invocationOptions,
    configListing: scopedListing([['global', 'core.sshcommand', 'ssh -o IdentitiesOnly=yes'], ['worktree', 'core.sshcommand', 'planted']]) });
  assert.ok(overridesOf(operatorAndPlanted.args).includes('core.sshCommand=ssh -o IdentitiesOnly=yes'));
  const operatorOnly = buildHardenedGitInvocation(['fetch'], { ...invocationOptions, configListing: scopedListing([['global', 'core.sshcommand', 'ssh -v']]) });
  assert.equal(overridesOf(operatorOnly.args).some((override) => override.startsWith('core.sshCommand=')), false);
});

test('hardened git invocation preserves subcommand placement after global configuration options', () => {
  const invocation = buildHardenedGitInvocation(['-c', 'core.filemode=false', '--no-optional-locks', 'show', 'HEAD:file'], invocationOptions);
  assert.deepEqual(invocation.args.slice(-7), ['-c', 'core.filemode=false', '--no-optional-locks', 'show', '--no-ext-diff', '--no-textconv', 'HEAD:file']);
});

test('filter driver names come only from attributes that name a driver', () => {
  const checkAttrOutput = ['a.bin', 'filter', 'lfs', 'b.txt', 'filter', 'unspecified', 'c', 'filter', 'set', 'd', 'filter', 'unset', 'secret.env', 'filter', 'git-crypt', 'e.bin', 'filter', 'lfs', ''].join('\0');
  assert.deepEqual(parseFilterDriverNames(checkAttrOutput), ['git-crypt', 'lfs']);
  assert.deepEqual(parseFilterDriverNames(''), []);
});

test('factory write ids come from JSON writer output or the defect command receipt', () => {
  assert.equal(factoryWrittenRecordId('{"id":"write-1"}'), 'write-1');
  assert.equal(factoryWrittenRecordId('defect-1  agent-assessed defect recorded by glimmervoid-factory\n'), 'defect-1');
  assert.equal(factoryWrittenRecordId('{"id":42}'), null);
  assert.equal(factoryWrittenRecordId('anything'), null);
});

test('trusted ledger validation refuses factory session records without a declared write id in every ledger directory', () => {
  for (const directory of ['work', 'consequences', 'defects', 'decisions', 'activity']) {
    const changes = [{ path: `.coherence/${directory}/s-factory.jsonl`, previousText: null,
      currentText: `${JSON.stringify({ id: 'forged', session: 'glimmervoid-factory' })}\n` }];
    assert.equal(findForbiddenLedgerWrites(changes, { trusted: true, writtenRecordIds: new Set(['written']) }).length, 1);
    assert.deepEqual(findForbiddenLedgerWrites(changes, { trusted: true, writtenRecordIds: new Set(['forged']) }), []);
  }
});

test('trusted ledger validation holds undeclared work records to the child-of-active-intent rule', () => {
  const workChange = (record: Record<string, unknown>) => [{ path: '.coherence/work/s-orchestrator.jsonl', previousText: null, currentText: `${JSON.stringify(record)}\n` }];
  const topLevel = workChange({ id: 'raced', session: 'orchestrator', event: 'opened', parent: null });
  assert.deepEqual(findForbiddenLedgerWrites(topLevel, { trusted: true, intentId: 'intent', writtenRecordIds: new Set(['declared']) }),
    ['.coherence/work/s-orchestrator.jsonl opened work that is not a child of the active intent']);
  assert.equal(findForbiddenLedgerWrites(topLevel, { trusted: true, intentId: null, writtenRecordIds: new Set(['raced']) }).length, 1);
  assert.deepEqual(findForbiddenLedgerWrites(workChange({ id: 'child', session: 'orchestrator', event: 'opened', parent: 'intent' }),
    { trusted: true, intentId: 'intent', writtenRecordIds: new Set() }), []);
  assert.deepEqual(findForbiddenLedgerWrites(workChange({ id: 'declared', session: 'glimmervoid-factory', event: 'opened', parent: null }),
    { trusted: true, intentId: null, writtenRecordIds: new Set(['declared']) }), []);
});

test('nested factory git commands receive numbered config overrides without inherited config or secrets', () => {
  const gitEnvironment = gitInvocationEnvironment(buildHardenedGitInvocation([], { ...invocationOptions, configListing: scopedListing([['local', 'filter.probe.process', 'x']]) }));
  const settings = Array.from({ length: Number(gitEnvironment.GIT_CONFIG_COUNT) }, (_, index) =>
    `${gitEnvironment[`GIT_CONFIG_KEY_${index}`]}=${gitEnvironment[`GIT_CONFIG_VALUE_${index}`]}`);
  assert.ok(settings.includes('core.fsmonitor=false'));
  assert.ok(settings.includes('filter.probe.process='));
  assert.equal(gitEnvironment.FACTORY_PROBE_TOKEN, undefined);
  assert.equal(gitEnvironment.GIT_CONFIG_PARAMETERS, undefined);
});

async function createRepository(context: test.TestContext, prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repo');
  await mkdir(repository);
  const git = async (args: string[], cwd = repository, env?: NodeJS.ProcessEnv) =>
    (await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: REAL_PROCESS_DEADLINE_MS, ...(env ? { env } : {}) })).stdout.trim();
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'factory@example.test']);
  await git(['config', 'user.name', 'Factory test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(repository, 'shared.txt'), 'base\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  return { directory, repository, git };
}

test('factory git runs operator credential helpers but never a repository-local one', { skip: process.platform === 'win32' }, async (context) => {
  const { directory, repository, git } = await createRepository(context, 'factory-credential-');
  const homeDir = path.join(directory, 'home');
  await mkdir(homeDir);
  const helperScript = (markerPath: string) => `!${process.execPath} -e "require('node:fs').writeFileSync(process.argv[1], 'ran')" ${markerPath}`;
  const operatorMarker = path.join(directory, 'operator-helper-ran');
  const plantedMarker = path.join(directory, 'planted-helper-ran');
  const homeEnv = { PATH: process.env.PATH, HOME: homeDir };
  await git(['config', '--global', 'credential.helper', helperScript(operatorMarker)], repository, homeEnv);
  await git(['config', 'credential.helper', helperScript(plantedMarker)]);
  await assert.rejects(() => runHardenedGit(['credential', 'fill'], { cwd: repository, encoding: 'utf8', timeout: REAL_PROCESS_DEADLINE_MS,
    env: homeEnv, input: 'protocol=https\nhost=example.test\n\n' }));
  await access(operatorMarker);
  await assert.rejects(() => access(plantedMarker));
});

test('the isolated git workspace runner keeps a caller env value across a rerere-replayed rebase continue', { skip: process.platform === 'win32' }, async (context) => {
  const { directory, repository, git } = await createRepository(context, 'factory-isolated-runner-');
  const origin = path.join(directory, 'origin.git');
  await git(['init', '--bare', origin]);
  await git(['remote', 'add', 'origin', origin]);
  await git(['push', '-u', 'origin', 'main']);
  await git(['config', 'rerere.enabled', 'true']);
  const invocations: { args: string[]; env: Record<string, string> | undefined }[] = [];
  const gitWorkspace = createGitWorkspace({ isolation: { disableRepoCommands: true }, git: async (args, cwd, extra) => {
    invocations.push({ args, env: extra?.replaceEnv });
    return (await execFileAsync('git', args, { cwd, env: extra?.replaceEnv, encoding: 'utf8', timeout: REAL_PROCESS_DEADLINE_MS })).stdout;
  } });
  const ledger = await gitWorkspace.create({ projectPath: repository, teamId: 'repo', label: 'ledger', baseBranch: 'main', configuredIntegrationBranch: 'main', worktreeBase: directory, shareList: [] });
  assert.ok(ledger.isGit);
  await writeFile(path.join(ledger.cwd, 'shared.txt'), 'ledger\n');
  await git(['commit', '-am', 'ledger change'], ledger.cwd);
  await writeFile(path.join(repository, 'shared.txt'), 'main\n');
  await git(['commit', '-am', 'main change']);
  await git(['push', 'origin', 'main']);
  await assert.rejects(() => git(['rebase', 'main'], ledger.cwd));
  await writeFile(path.join(ledger.cwd, 'shared.txt'), 'resolved\n');
  await git(['add', 'shared.txt'], ledger.cwd);
  await git(['-c', 'core.editor=true', 'rebase', '--continue'], ledger.cwd);
  await git(['reset', '--hard', 'ORIG_HEAD'], ledger.cwd);
  const merged = await gitWorkspace.mergeKeep({ projectPath: repository, workspace: ledger, targetBranch: 'main' });
  assert.equal(merged.merged, true, JSON.stringify(merged));
  assert.equal(merged.rerereReplayed, true);
  const continued = invocations.find(({ args }) => args.includes('rebase') && args.includes('--continue'));
  assert.ok(continued);
  assert.equal(continued.env?.GIT_EDITOR, 'true');
  assert.ok(continued.args.includes('core.hooksPath=/dev/null'));
  assert.equal(await git(['show', 'main:shared.txt']), 'resolved');
  assert.equal(await git(['rev-parse', 'main'], origin), await git(['rev-parse', 'main']));
});

test('factory git pipes a tracked path list larger than the pipe buffer through check-attr without the config probe failing', async (context) => {
  const { repository } = await createRepository(context, 'factory-large-input-');
  const longPathList = Array.from({ length: 4000 }, (_, index) => `${'directory-'.repeat(4)}/tracked-file-${index}.txt`).join('\0');
  assert.ok(Buffer.byteLength(longPathList) > 128 * 1024);
  const { stdout } = await runHardenedGit(['check-attr', '--stdin', '-z', 'filter'], { cwd: repository, encoding: 'utf8',
    timeout: REAL_PROCESS_DEADLINE_MS, maxBuffer: 64 * 1024 * 1024, input: longPathList });
  assert.deepEqual(parseFilterDriverNames(stdout), []);
});

test('the isolated git workspace runner hands git the server transport env when the caller replace env was scrubbed of it', { skip: process.platform === 'win32' }, async (context) => {
  const { directory, repository, git } = await createRepository(context, 'factory-transport-env-');
  const origin = path.join(directory, 'origin.git');
  await git(['init', '--bare', origin]);
  await git(['remote', 'add', 'origin', origin]);
  await git(['push', '-u', 'origin', 'main']);
  const previousSshCommand = process.env.GIT_SSH_COMMAND;
  const previousAgentSocket = process.env.SSH_AUTH_SOCK;
  process.env.GIT_SSH_COMMAND = 'ssh -i server-key';
  process.env.SSH_AUTH_SOCK = '/server-agent.sock';
  context.after(() => {
    if (previousSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
    if (previousSshCommand !== undefined) process.env.GIT_SSH_COMMAND = previousSshCommand;
    if (previousAgentSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    if (previousAgentSocket !== undefined) process.env.SSH_AUTH_SOCK = previousAgentSocket;
  });
  const scrubbedReplaceEnv = buildFactoryCheckEnv(process.env, process.platform);
  assert.equal(scrubbedReplaceEnv.GIT_SSH_COMMAND, undefined);
  assert.equal(scrubbedReplaceEnv.SSH_AUTH_SOCK, undefined);
  const invocations: { args: string[]; env: Record<string, string> | undefined }[] = [];
  const gitWorkspace = createGitWorkspace({ git: async (args, cwd, extra) => {
    invocations.push({ args, env: extra?.replaceEnv });
    return (await execFileAsync('git', args, { cwd, env: extra?.replaceEnv, encoding: 'utf8', timeout: REAL_PROCESS_DEADLINE_MS })).stdout;
  } });
  const ledger = await gitWorkspace.create({ projectPath: repository, teamId: 'repo', label: 'ledger', baseBranch: 'main', configuredIntegrationBranch: 'main', worktreeBase: directory, shareList: [] });
  assert.ok(ledger.isGit);
  await writeFile(path.join(ledger.cwd, 'shared.txt'), 'ledger\n');
  await git(['commit', '-am', 'ledger change'], ledger.cwd);
  invocations.length = 0;
  const merged = await gitWorkspace.mergeKeep({ projectPath: repository, workspace: ledger, targetBranch: 'main',
    disableHooks: true, disableRepoCommands: true, replaceEnv: scrubbedReplaceEnv });
  assert.equal(merged.merged, true, JSON.stringify(merged));
  const transportInvocations = invocations.filter(({ args }) => args.includes('fetch') || args.includes('push'));
  assert.ok(transportInvocations.length > 0);
  for (const { env } of transportInvocations) {
    assert.equal(env?.GIT_SSH_COMMAND, 'ssh -i server-key');
    assert.equal(env?.SSH_AUTH_SOCK, '/server-agent.sock');
  }
  assert.equal(await git(['rev-parse', 'main'], origin), await git(['rev-parse', 'main']));
});

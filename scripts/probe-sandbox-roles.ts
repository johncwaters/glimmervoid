import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { SandboxRole } from '../server/core/sandbox-policy-core.ts';
import type { SessionSandboxFacts } from '../session/sessions.ts';

type RoleName = 'check' | 'judge' | 'worker';
type Expectation = 'succeeds' | 'fails';
type ProbeRow = { role: RoleName; check: string; status: 'PASS' | 'FAIL' | 'SKIPPED'; reason?: string };
type ToolAttempt = { type: string; name: string; input: Record<string, string> };
type StreamEvent = { type: string; message?: { content?: ToolAttempt[] } };

const ROLE_NAMES: readonly RoleName[] = ['check', 'judge', 'worker'];
const AGENT_IDS = ['claude-code', 'codex'];
const AGENT_RUN_TIMEOUT_MS = 240_000;

const { values: flags } = parseArgs({ options: { role: { type: 'string', multiple: true }, agent: { type: 'string', default: 'claude-code' } } });
const selectedRoles = ROLE_NAMES.filter((roleName) => !flags.role || flags.role.includes(roleName));
const unknownRoles = (flags.role ?? []).filter((roleName) => !ROLE_NAMES.some((known) => known === roleName));
assert.deepEqual(unknownRoles, [], `unknown role, expected one of ${ROLE_NAMES.join(', ')}`);
assert.ok(AGENT_IDS.includes(flags.agent), `unknown agent, expected one of ${AGENT_IDS.join(', ')}`);
const agentId = flags.agent;

const probeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-role-probe-')));
const probeHome = path.join(probeRoot, 'home');
await mkdir(probeHome, { recursive: true });
process.env.GLIMMERVOID_HOME = probeHome;
const homeSecretFile = path.join(probeHome, 'secret.txt');
await writeFile(homeSecretFile, 'home-secret\n');

const { execFileAsync } = await import('../server/child-process-safe.ts');
const { awaitSessionExit } = await import('../server/ephemeral-session.ts');
const { createGitWorkspace, runHardenedGit } = await import('../server/git-workspace.ts');
const { prepareSandboxLaunch } = await import('../server/sandbox-launch.ts');
const { Session } = await import('../session/sessions.ts');

const EXPECTATIONS: Readonly<Record<RoleName, Readonly<Record<string, Expectation>>>> = {
  check: {
    tools_resolve: 'succeeds', scratch_write: 'succeeds', checkout_write: 'fails', git_add: 'fails', hooks_write: 'fails', update_ref: 'fails', claude_dir: 'fails',
    git_pointer: 'fails', home_read: 'fails', outside_write: 'fails', web: 'fails', hook_port: 'fails', other_port: 'fails', user_bus: 'fails',
  },
  judge: {
    tools_resolve: 'succeeds', scratch_write: 'succeeds', checkout_write: 'fails', git_add: 'fails', hooks_write: 'fails', update_ref: 'fails', claude_dir: 'fails',
    git_pointer: 'fails', home_read: 'fails', outside_write: 'fails', web: 'fails', hook_port: 'succeeds', other_port: 'fails', user_bus: 'fails',
  },
  worker: {
    tools_resolve: 'succeeds', scratch_write: 'succeeds', checkout_write: 'succeeds', git_add: 'fails', hooks_write: 'fails', update_ref: 'fails', claude_dir: 'fails',
    git_pointer: 'fails', home_read: 'fails', outside_write: 'fails', web: 'succeeds', hook_port: 'succeeds', other_port: 'succeeds', user_bus: 'fails',
  },
};

const probeRows: ProbeRow[] = [];
const hookRequests: string[] = [];
const otherPortRequests: string[] = [];

function startListener(requestUrls: string[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requestUrls.push(request.url ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

const hookListener = await startListener(hookRequests);
const otherListener = await startListener(otherPortRequests);
const hookPort = (hookListener.address() as AddressInfo).port;
const otherPort = (otherListener.address() as AddressInfo).port;

async function record(role: RoleName, check: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    probeRows.push({ role, check, status: 'PASS' });
  } catch (error) {
    probeRows.push({ role, check, status: 'FAIL', reason: String(error).slice(0, 300) });
  }
}

function toolAttempts(output: string): ToolAttempt[] {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('{')) return [];
    const event = JSON.parse(line) as StreamEvent;
    if (event.type !== 'assistant') return [];
    return (event.message?.content ?? []).filter((entry) => entry.type === 'tool_use');
  });
}

function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function isUserBusReachableFromHost(): Promise<boolean> {
  try {
    await execFileAsync('busctl', ['--user', 'list'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const isUserBusProbed = await isUserBusReachableFromHost();
const toolsTheChecksRelyOn = ['curl', 'git', ...(isUserBusProbed ? ['busctl'] : [])];

function describeRole(roleName: RoleName, checkout: string, evidenceDir: string, facts: SessionSandboxFacts): SandboxRole {
  const vendors = roleName === 'check' ? [] : [agentId === 'codex' ? 'codex' as const : 'claude' as const];
  const shared = { vendors, vendorHome: 'lane' as const, commitCheckouts: [], readDenied: [], readableWithinDenied: facts.readablePaths };
  if (roleName === 'check') return { ...shared, network: { access: 'none' }, writableRoots: [evidenceDir], lockedCheckouts: [] };
  if (roleName === 'judge') return { ...shared, network: { access: 'allowlist', domains: [], hookPort: facts.hookPort }, writableRoots: [evidenceDir], lockedCheckouts: [] };
  return { ...shared, network: { access: 'open' }, writableRoots: [evidenceDir], lockedCheckouts: [checkout] };
}

async function runAgent(roleName: RoleName, checkout: string, evidenceDir: string, task: string): Promise<string> {
  const agentArgs = agentId === 'codex'
    ? ['exec', '--skip-git-repo-check']
    : ['-p', '--model', 'haiku', '--verbose', '--output-format', 'stream-json'];
  const session = new Session({
    id: `probe-${roleName}`,
    name: `probe-${roleName}`,
    path: checkout,
    agent: agentId,
    dangerouslySkipPermissions: true,
    bypassHookTrust: true,
    extraClaudeArgs: agentArgs,
    initialPrompt: task,
    ephemeral: true,
    hookRouter: { register: () => {}, unregister: () => {} },
    getHookPort: () => hookPort,
    hooksBaseDir: path.join(probeHome, 'scratch', 'glimmervoid-hooks'),
    prepareSandbox: (facts) => prepareSandboxLaunch({ role: describeRole(roleName, checkout, evidenceDir, facts), launchId: facts.launchId }),
  });
  let output = '';
  session.on('data', (chunk: string) => { output += chunk; });
  try {
    await awaitSessionExit(session, { signal: AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS) });
  } finally {
    session.destroy();
  }
  return output;
}

async function runCheckCommand(checkout: string, evidenceDir: string, scriptFile: string): Promise<void> {
  const prepared = await prepareSandboxLaunch({
    role: describeRole('check', checkout, evidenceDir, { launchId: 'probe-check', cwd: checkout, hookPort: null, readablePaths: [] }),
    launchId: 'probe-check',
  });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.reason);
  try {
    const wrapped = await prepared.launch.wrap('sh', [scriptFile]);
    await execFileAsync(wrapped.file, wrapped.args, { cwd: checkout, env: { ...process.env, ...prepared.launch.env }, timeout: 120_000 });
  } finally {
    await prepared.launch.dispose();
  }
}

async function leftoverLaunchFiles(): Promise<string[]> {
  const folders = ['sandbox-policies', 'sandbox-temp'].map((folder) => path.join(probeHome, folder));
  const listings = await Promise.all(folders.map((folder) => readdir(folder).catch(() => [])));
  return listings.flat();
}

try {
  for (const roleName of selectedRoles) {
    const roleRoot = path.join(probeRoot, roleName);
    const repository = path.join(roleRoot, 'repo');
    const evidenceDir = path.join(roleRoot, 'evidence');
    await mkdir(repository, { recursive: true });
    await mkdir(evidenceDir, { recursive: true });
    const runGit = (gitArguments: string[], cwd = repository) => runHardenedGit(gitArguments, { cwd, timeout: 30_000 });
    await runGit(['init', '-b', 'main']);
    await runGit(['config', 'user.name', 'Role probe']);
    await runGit(['config', 'user.email', 'role-probe@example.test']);
    await runGit(['config', 'commit.gpgsign', 'false']);
    await writeFile(path.join(repository, 'initial.txt'), 'initial\n');
    await runGit(['add', 'initial.txt']);
    await runGit(['commit', '-m', 'initial']);
    const initialSha = (await runGit(['rev-parse', 'HEAD'])).stdout.trim();
    const workspace = await createGitWorkspace().create({ projectPath: repository, teamId: 'probe', label: roleName,
      baseBranch: 'main', configuredIntegrationBranch: 'main', worktreeBase: roleRoot, shareList: [] });
    assert.equal(workspace.isGit, true);
    const checkout = await realpath(workspace.cwd);
    const commonDir = await realpath(path.join(repository, '.git'));
    const replacementSha = (await runGit(['commit-tree', `${initialSha}^{tree}`, '-p', initialSha, '-m', 'replacement'])).stdout.trim();
    const outsideToolFile = path.join(repository, 'outside-tool.txt');
    const outsideShellFile = path.join(repository, 'outside-shell.txt');
    const hooksFile = path.join(commonDir, 'hooks', 'role-probe');
    const gitPointerFile = path.join(checkout, '.git');
    const gitPointerText = await readFile(gitPointerFile, 'utf8');
    const claudeProbeDir = path.join(checkout, '.claude', 'probe');
    const resultsFile = path.join(evidenceDir, 'results.txt');
    const scriptFile = path.join(evidenceDir, 'probe.sh');
    const checkCommands: Readonly<Record<string, string>> = {
      tools_resolve: `{ ${toolsTheChecksRelyOn.map((tool) => `command -v ${tool}`).join(' && ')}; }`,
      scratch_write: `printf scratch > ${shellQuoted(path.join(evidenceDir, 'scratch.txt'))}`,
      checkout_write: `printf owned > ${shellQuoted(path.join(checkout, 'owned.txt'))}`,
      git_add: `git -C ${shellQuoted(checkout)} add initial.txt`,
      hooks_write: `printf hooks > ${shellQuoted(hooksFile)}`,
      update_ref: `git -C ${shellQuoted(checkout)} update-ref refs/heads/main ${replacementSha}`,
      claude_dir: `mkdir -p ${shellQuoted(claudeProbeDir)}`,
      git_pointer: `printf pointer > ${shellQuoted(gitPointerFile)}`,
      home_read: `cat ${shellQuoted(homeSecretFile)}`,
      outside_write: `printf outside > ${shellQuoted(outsideShellFile)}`,
      web: 'curl -sf -m 10 -o /dev/null https://example.com',
      hook_port: `curl -sf -m 10 -o /dev/null http://127.0.0.1:${hookPort}/probe-ping/${roleName}`,
      other_port: `curl -sf -m 10 -o /dev/null http://127.0.0.1:${otherPort}/probe-ping/${roleName}`,
      ...(isUserBusProbed ? { user_bus: 'busctl --user list' } : {}),
    };
    const scriptLines = Object.entries(checkCommands).map(([check, command]) => `${command} >/dev/null 2>&1; echo "${check}=$?" >> ${shellQuoted(resultsFile)}`);
    await writeFile(scriptFile, `${scriptLines.join('\n')}\n`);
    const task = [
      'This is a sandbox contract probe. Do exactly these steps once each, in order, and do not work around a denial or retry.',
      `1. Use the file writing tool to write "outside" to ${outsideToolFile}. This is expected to be denied.`,
      `2. Run exactly this shell command: sh ${scriptFile}`,
      '3. Reply with the single word done.',
    ].join('\n');
    let agentOutput = '';
    await record(roleName, roleName === 'check' ? 'check command run' : `${agentId} run`, async () => {
      if (roleName === 'check') return runCheckCommand(checkout, evidenceDir, scriptFile);
      agentOutput = await runAgent(roleName, checkout, evidenceDir, task);
      await writeFile(path.join(roleRoot, 'agent-output.txt'), agentOutput);
    });
    const resultLines = (await readFile(resultsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    const exitCodeByCheck = new Map(resultLines.map((line) => { const [check, exitCode] = line.split('='); return [check, Number(exitCode)] as const; }));
    for (const check of Object.keys(checkCommands)) {
      const expectation = EXPECTATIONS[roleName][check];
      await record(roleName, `${check} ${expectation}`, async () => {
        const exitCode = exitCodeByCheck.get(check);
        assert.ok(exitCode !== undefined, 'the check did not run');
        assert.equal(exitCode === 0 ? 'succeeds' : 'fails', expectation, `exit code ${exitCode}`);
      });
    }
    if (!isUserBusProbed) probeRows.push({ role: roleName, check: `user_bus ${EXPECTATIONS[roleName].user_bus}`, status: 'SKIPPED', reason: 'the user bus is unreachable from the host, so the check was not run' });
    await record(roleName, 'host state untouched', async () => {
      await assert.rejects(readFile(outsideShellFile), { code: 'ENOENT' });
      await assert.rejects(readFile(outsideToolFile), { code: 'ENOENT' });
      await assert.rejects(readFile(hooksFile), { code: 'ENOENT' });
      assert.equal(existsSync(claudeProbeDir), false, 'the .claude probe directory was created on the host');
      assert.equal(await readFile(gitPointerFile, 'utf8'), gitPointerText);
      assert.equal((await runGit(['rev-parse', 'refs/heads/main'])).stdout.trim(), initialSha);
      assert.equal((await runGit(['diff', '--cached', '--name-only'], checkout)).stdout.trim(), '');
    });
    await record(roleName, 'loopback ports reached only as the role allows', async () => {
      const pingPath = `/probe-ping/${roleName}`;
      assert.equal(hookRequests.includes(pingPath), EXPECTATIONS[roleName].hook_port === 'succeeds', 'hook listener');
      assert.equal(otherPortRequests.includes(pingPath), EXPECTATIONS[roleName].other_port === 'succeeds', 'other listener');
    });
    if (roleName !== 'check' && agentId === 'claude-code') await record(roleName, 'file tool write outside attempted', async () => {
      assert.ok(toolAttempts(agentOutput).some((tool) => tool.name === 'Write' && tool.input.file_path === outsideToolFile), 'the outside Write was not attempted');
    });
    if (roleName !== 'check' && agentId === 'codex') probeRows.push({ role: roleName, check: 'file tool write outside attempted', status: 'SKIPPED', reason: 'Codex output carries no structured tool events' });
    if (roleName !== 'check') await record(roleName, 'Stop hook reached the host listener', async () => {
      assert.ok(hookRequests.some((requestUrl) => requestUrl.startsWith(`/hook/probe-${roleName}/stop?`)), `hook requests seen: ${hookRequests.join(' ')}`);
    });
    await record(roleName, 'policy and temp files removed', async () => {
      assert.deepEqual(await leftoverLaunchFiles(), []);
    });
  }
} finally {
  await new Promise<void>((resolve) => hookListener.close(() => resolve()));
  await new Promise<void>((resolve) => otherListener.close(() => resolve()));
  console.table(probeRows);
  const hasFailures = probeRows.some((row) => row.status === 'FAIL');
  if (hasFailures) console.log(`Probe artifacts: ${probeRoot}`);
  if (!hasFailures) await rm(probeRoot, { recursive: true, force: true });
  if (hasFailures) process.exitCode = 1;
}

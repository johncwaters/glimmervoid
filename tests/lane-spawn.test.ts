import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LANE_CONFIG_EDIT_DENY_RULES } from '../server/lanes/core/lane-permissions-core.ts';
import { LANE_CREDENTIAL_ENV } from '../server/guardrails/core/guardrails-roles-core.ts';
import { createLaneSpawn } from '../server/lanes/lane-spawn.ts';
import type { LaneCoherenceJournal } from '../server/lanes/lane-spawn.ts';
import { FACTORY_REVIEWER_PERMISSIONS, FACTORY_REVIEWER_SPAWN_ENV, FACTORY_REVIEWER_TOOLS } from '../server/factory/factory-closeout.ts';
import { THREAD_JUDGE_TOOLS } from '../server/github/team-review-thread-judge.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import type { GuardrailsRole } from '../server/guardrails/core/guardrails-policy-core.ts';

async function spawnedOptions(allowTools: readonly string[] | undefined, hasHookRouter: boolean): Promise<SessionOptions> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-lane-spawn-test-'));
  const captured: SessionOptions[] = [];
  const controller = new AbortController();
  controller.abort();
  try {
    const spawnLane = createLaneSpawn({
      laneName: 'lane-spawn-test',
      platform: 'linux',
      hookRouter: hasHookRouter ? { register: () => {}, unregister: () => {} } : null,
      ...(allowTools ? { allowTools } : {}),
      createSession: (options) => {
        captured.push(options);
        return new Session(options);
      },
    });
    await spawnLane({ id: `lane-spawn-test-${captured.length}`, name: 'Lane spawn test', prompt: 'Synthetic prompt', cwd, model: 'sonnet', signal: controller.signal });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
  assert.equal(captured.length, 1);
  return captured[0];
}

function toolsArgument(options: SessionOptions): string | undefined {
  const args = options.extraClaudeArgs ?? [];
  const index = args.indexOf('--tools');
  return index === -1 ? undefined : args[index + 1];
}

test('the thread judge allow list reaches the guarded session as --tools Read,Write with and without a hook router', async () => {
  for (const hasHookRouter of [true, false]) {
    const options = await spawnedOptions(THREAD_JUDGE_TOOLS, hasHookRouter);
    assert.equal(toolsArgument(options), 'Read,Write', `hookRouter: ${hasHookRouter}`);
    assert.equal(typeof options.prepareGuardrails, 'function');
    assert.equal((options.extraClaudeArgs ?? []).includes('--settings'), !hasHookRouter);
  }
});

test('a guarded lane refuses to spawn with the reason when the guardrails cannot start', async () => {
  const spawnLane = createLaneSpawn({
    laneName: 'lane-spawn-test', platform: 'linux', guardrailsRefusal: () => 'bwrap is missing',
    createSession: () => assert.fail('a lane that cannot be guarded must not spawn'),
  });
  await assert.rejects(spawnLane({ id: 'lane-spawn-refused', name: 'Lane spawn test', prompt: 'Synthetic prompt', cwd: os.tmpdir() }), /bwrap is missing/);
});

test('a lane spawned without an allow list emits no --tools argument', async () => {
  for (const hasHookRouter of [true, false]) {
    const options = await spawnedOptions(undefined, hasHookRouter);
    assert.equal(toolsArgument(options), undefined, `hookRouter: ${hasHookRouter}`);
  }
});

test('standalone settings exist before start and are removed after exit, start failure, construction failure or abort', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-lane-settings-test-'));
  try {
    for (const outcome of ['exit', 'start-failure', 'construction-failure', 'abort', 'already-aborted']) {
      let settingsPath = '';
      let hasStarted = false;
      const controller = new AbortController();
      if (outcome === 'already-aborted') controller.abort();
      const spawnLane = createLaneSpawn({
        laneName: 'lane-settings-test',
        allowTools: THREAD_JUDGE_TOOLS,
        createSession: (options) => {
          const args = options.extraClaudeArgs ?? [];
          settingsPath = args[args.indexOf('--settings') + 1];
          if (outcome === 'construction-failure') throw new Error('synthetic construction failure');
          const session = new Session(options);
          session.start = async () => {
            hasStarted = true;
            assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { permissions: options.settingsPermissions });
            if (outcome === 'start-failure') throw new Error('synthetic start failure');
            if (outcome === 'abort') return controller.abort();
            session.emit('exit');
          };
          return session;
        },
      });
      const spawned = spawnLane({ id: `lane-settings-test-${outcome}`, name: 'Lane settings test', prompt: 'Synthetic prompt', cwd, signal: controller.signal });
      const shouldFail = outcome === 'start-failure' || outcome === 'construction-failure';
      if (shouldFail) await assert.rejects(spawned, /synthetic (start|construction) failure/);
      if (!shouldFail) await spawned;
      assert.ok(settingsPath);
      assert.equal(hasStarted, outcome !== 'already-aborted' && outcome !== 'construction-failure');
      await assert.rejects(fs.stat(path.dirname(settingsPath)), { code: 'ENOENT' });
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a failed standalone settings write removes its directory without constructing a session', async (context) => {
  let settingsPath = '';
  let hasConstructedSession = false;
  context.mock.method(fs, 'writeFile', async (filePath: string) => {
    settingsPath = filePath;
    throw new Error('synthetic settings write failure');
  });
  const spawnLane = createLaneSpawn({
    laneName: 'lane-settings-write-test',
    createSession: (options) => {
      hasConstructedSession = true;
      return new Session(options);
    },
  });
  await assert.rejects(spawnLane({ id: 'lane-settings-write-test', name: 'Lane settings test', prompt: 'Synthetic prompt', cwd: os.tmpdir() }), /synthetic settings write failure/);
  assert.equal(hasConstructedSession, false);
  assert.ok(settingsPath);
  await assert.rejects(fs.stat(path.dirname(settingsPath)), { code: 'ENOENT' });
});


test('factory reviewer spawns wrapped in the judge guardrails role with its prompt file readable, structured output, a selectable model and an optional Coherence journal', async () => {
  const coherenceCli = { nodePath: '/usr/bin/node', cliPath: '/opt/coherence/dist/cli.js', hookCliPath: '/opt/coherence/dist/hook-cli.js' };
  const coherenceHookCommands = ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse'].map((event) => `"/usr/bin/node" "/opt/coherence/dist/hook-cli.js" ${event}`);
  for (const [hasHookRouter, hasJournal] of [[true, false], [false, false], [true, true], [false, true]]) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-review-spawn-'));
    const captured: SessionOptions[] = [];
    const createdSessions: Session[] = [];
    const chunks: string[] = [];
    const preparedRoles: GuardrailsRole[] = [];
    const standaloneSettings: unknown[] = [];
    const shimFileNames: string[][] = [];
    const landedJournals: LaneCoherenceJournal[] = [];
    const promptFile = path.join(path.dirname(cwd), 'prompt.txt');
    try {
      const spawnReviewer = createLaneSpawn({
        prepareGuardrails: async ({ role }) => { preparedRoles.push(role); return { ok: false, reason: 'synthetic' }; },
        laneName: 'factory', platform: 'linux', getHookPort: () => 3911, allowTools: FACTORY_REVIEWER_TOOLS, settingsPermissions: FACTORY_REVIEWER_PERMISSIONS, spawnEnv: FACTORY_REVIEWER_SPAWN_ENV,
        hookRouter: hasHookRouter ? { register: () => {}, unregister: () => {} } : null, coherenceCli,
        createSession: (options) => {
          captured.push(options);
          const session = new Session(options);
          createdSessions.push(session);
          session.start = async () => {
            const args = options.extraClaudeArgs ?? [];
            if (args.includes('--settings')) standaloneSettings.push(JSON.parse(await fs.readFile(args[args.indexOf('--settings') + 1], 'utf8')));
            for (const shimDir of options.prependPathDirs ?? []) shimFileNames.push((await fs.readdir(shimDir)).sort());
            session.emit('data', '{"type":"result"}');
            session.emit('exit');
          };
          return session;
        },
      });
      await spawnReviewer({ id: 'factory-review', name: 'Factory review', cwd, model: 'sonnet',
        prompt: 'Review the assigned factory ticket and return its structured verdict.',
        landCoherenceJournal: hasJournal ? async (laneJournal) => { landedJournals.push(laneJournal); } : null,
        extraArgs: ['--output-format', 'json', '--permission-mode', 'dontAsk'], readablePaths: [promptFile], onOutput: (chunk) => { chunks.push(chunk); } });
      const options = captured[0];
      const args = options.extraClaudeArgs ?? [];
      const claudeSessionId = hasJournal ? args[args.indexOf('--session-id') + 1] : null;
      const shimDirs = options.prependPathDirs ?? [];
      const journalEnv = hasJournal ? { COHERENCE_PROJECT_ROOT: cwd, COHERENCE_HOOK_HOST: 'claude' } : {};
      assert.equal(args.includes('--session-id'), hasJournal);
      if (claudeSessionId !== null) assert.match(claudeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.deepEqual(landedJournals, hasJournal ? [{ cwd, claudeSessionId }] : []);
      assert.equal(shimDirs.length, hasJournal ? 1 : 0);
      assert.equal(shimDirs.some((shimDir) => shimDir.startsWith(cwd)), false);
      assert.deepEqual(shimFileNames, hasJournal ? [['coherence', 'coherence.cmd']] : []);
      for (const shimDir of shimDirs) await assert.rejects(fs.stat(shimDir), { code: 'ENOENT' });
      const laneHookCommands = hasHookRouter
        ? (options.extraUserHooks ?? []).map((hook) => hook.command)
        : Object.values((standaloneSettings[0] as { hooks?: Record<string, { hooks: { command: string }[] }[]> }).hooks ?? {}).flat().flatMap((entry) => entry.hooks.map((handler) => handler.command));
      assert.deepEqual(coherenceHookCommands.filter((command) => laneHookCommands.includes(command)), hasJournal ? coherenceHookCommands : []);
      if (!hasHookRouter) assert.deepEqual(Object.keys(standaloneSettings[0] as object), hasJournal ? ['permissions', 'hooks'] : ['permissions']);
      assert.equal(options.path, cwd);
      assert.equal(options.dangerouslySkipPermissions, false);
      assert.equal(options.ephemeral, true);
      assert.equal(options.agent, 'claude-code');
      assert.equal(toolsArgument(options), 'Read,Glob,Grep,Bash');
      assert.deepEqual(options.settingsPermissions, {
        defaultMode: 'dontAsk', allow: ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', ...(hasJournal ? ['Bash(coherence decide:*)'] : [])],
        deny: ['Edit', 'Write', 'NotebookEdit', ...LANE_CONFIG_EDIT_DENY_RULES],
      });
      assert.equal(args.includes('-p'), true);
      assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
      assert.equal(args[args.indexOf('--output-format') + 1], 'json');
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
      assert.equal(args.includes('--strict-mcp-config'), true);
      assert.equal(args.includes('--disable-slash-commands'), true);
      assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local');
      assert.deepEqual(chunks, ['{"type":"result"}']);
      assert.deepEqual(options.spawnEnv, { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0', ...journalEnv, ...LANE_CREDENTIAL_ENV });
      assert.equal(options.settingsGuardrails ?? null, null);
      await options.prepareGuardrails?.({ launchId: 'launch-one', cwd, hookPort: 3911, readablePaths: ['/hook/settings'], writablePaths: [], agentSessionId: 'agent-session-one' });
      assert.deepEqual(preparedRoles, [{
        vendors: ['claude'], vendorHome: { scope: 'launch', cwd, agentSessionId: 'agent-session-one' }, network: { access: 'allowlist', domains: [], hookPort: 3911 },
        writableRoots: [cwd], lockedCheckouts: [], commitCheckouts: [], readDenied: [], readableWithinDenied: ['/hook/settings', promptFile, ...shimDirs],
      }]);
      if (hasHookRouter) {
        assert.equal(options.getHookTools, null);
        assert.equal(options.hookTools?.some((tool) => tool.id === 'saneYolo'), true);
      }
      const inheritedSetting = process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
      process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
      try {
        assert.equal(createdSessions[0]._buildSpawnEnv({}).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '0');
      } finally {
        if (inheritedSetting === undefined) delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
        if (inheritedSetting !== undefined) process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = inheritedSetting;
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

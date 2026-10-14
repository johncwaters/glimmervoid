import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeFolderTrust } from '../server/claude-trust.ts';
import { CLAUDE_CONFIG_LOCK_STALE_MS, repositoryRootOfCommonGitDir } from '../server/core/claude-trust-core.ts';

const REPOSITORY_ROOT = '/work/seeded-repo';
const OTHER_ROOT = '/work/other-repo';
const GRANTED_ENTRY_KEYS = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };

async function prepareClaudeConfig(t: test.TestContext, configText: string | null, platform?: NodeJS.Platform) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-claude-trust-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  const configPath = path.join(configDir, '.claude.json');
  if (configText !== null) await fs.writeFile(configPath, configText, { mode: 0o600 });
  const waits: number[] = [];
  const trust = createClaudeFolderTrust({ env: { CLAUDE_CONFIG_DIR: configDir }, platform, sleep: async (durationMs) => { waits.push(durationMs); } });
  return { configDir, configPath, trust, waits };
}

test('granting trust approves the folder and its external CLAUDE.md imports in one project entry and leaves the rest of the Claude config as it was', async (t) => {
  const original = {
    numStartups: 7,
    oauthAccount: { emailAddress: 'operator@example.test' },
    projects: {
      [OTHER_ROOT]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false },
      [REPOSITORY_ROOT]: { allowedTools: [], mcpServers: { local: { command: 'node' } }, hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, lastCost: 0.25 },
    },
    userID: 'kept',
  };
  const { configDir, configPath, trust } = await prepareClaudeConfig(t, JSON.stringify(original, null, 2));

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'granted');

  const writtenText = await fs.readFile(configPath, 'utf8');
  const expected = structuredClone(original);
  Object.assign(expected.projects[REPOSITORY_ROOT], GRANTED_ENTRY_KEYS);
  assert.equal(writtenText, JSON.stringify(expected, null, 2));
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(configDir), ['.claude.json']);

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'already-trusted');
  assert.equal(await fs.readFile(configPath, 'utf8'), writtenText);
});

test('a folder Claude Code has never seen gets an entry that approves only trust and external CLAUDE.md imports', async (t) => {
  const { configPath, trust } = await prepareClaudeConfig(t, `${JSON.stringify({ userID: 'kept' }, null, 2)}\n`);

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'granted');

  const writtenText = await fs.readFile(configPath, 'utf8');
  assert.ok(writtenText.endsWith('}\n'));
  assert.deepEqual(JSON.parse(writtenText), {
    userID: 'kept',
    projects: { [REPOSITORY_ROOT]: { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], ...GRANTED_ENTRY_KEYS } },
  });
});

test('a folder trusted by an earlier trust-only grant is granted again so Claude Code stops asking about external CLAUDE.md imports', async (t) => {
  const { configPath, trust } = await prepareClaudeConfig(t, JSON.stringify({ projects: { [REPOSITORY_ROOT]: { hasTrustDialogAccepted: true } } }, null, 2));

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'granted');

  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), { projects: { [REPOSITORY_ROOT]: GRANTED_ENTRY_KEYS } });
});

test('a folder where the operator declined external CLAUDE.md imports is trusted but keeps the decline', async (t) => {
  const declinedEntry = { hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true };
  const { configPath, trust } = await prepareClaudeConfig(t, JSON.stringify({ projects: { [REPOSITORY_ROOT]: declinedEntry } }, null, 2));

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'granted');
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), { projects: { [REPOSITORY_ROOT]: { ...declinedEntry, hasTrustDialogAccepted: true } } });

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'already-trusted');
});

test('a legacy .config.json in the Claude config home is the file that gets the grant', async (t) => {
  const untrustedText = JSON.stringify({ projects: { [REPOSITORY_ROOT]: { hasTrustDialogAccepted: false } } }, null, 2);
  const { configDir, configPath, trust } = await prepareClaudeConfig(t, untrustedText);
  const legacyConfigPath = path.join(configDir, '.config.json');
  await fs.writeFile(legacyConfigPath, untrustedText, { mode: 0o600 });

  assert.equal(await trust.ensureTrusted(REPOSITORY_ROOT), 'granted');

  assert.deepEqual(JSON.parse(await fs.readFile(legacyConfigPath, 'utf8')), { projects: { [REPOSITORY_ROOT]: GRANTED_ENTRY_KEYS } });
  assert.equal(await fs.readFile(configPath, 'utf8'), untrustedText);
});

test('a Windows folder is looked up under the forward-slash key Claude Code stores it by', async (t) => {
  const trustedText = JSON.stringify({ projects: { 'C:/work/seeded-repo': GRANTED_ENTRY_KEYS } }, null, 2);
  const { configPath, trust } = await prepareClaudeConfig(t, trustedText, 'win32');

  assert.equal(await trust.ensureTrusted('C:\\work\\seeded-repo'), 'already-trusted');
  assert.equal(await fs.readFile(configPath, 'utf8'), trustedText);
});

test('a missing, corrupt or misshapen Claude config is refused by name and never written', async (t) => {
  const missing = await prepareClaudeConfig(t, null);
  await assert.rejects(missing.trust.ensureTrusted(REPOSITORY_ROOT), /Could not trust \/work\/seeded-repo for Claude Code: .*could not be read \(ENOENT\)/);
  assert.deepEqual(await fs.readdir(missing.configDir), []);

  for (const unreadableText of ['{ "projects": ', '[]', JSON.stringify({ projects: [] }), JSON.stringify({ projects: { [REPOSITORY_ROOT]: 'yes' } })]) {
    const unreadable = await prepareClaudeConfig(t, unreadableText);
    await assert.rejects(unreadable.trust.ensureTrusted(REPOSITORY_ROOT), /was left unchanged because/);
    assert.equal(await fs.readFile(unreadable.configPath, 'utf8'), unreadableText);
    assert.deepEqual(await fs.readdir(unreadable.configDir), ['.claude.json']);
  }
});

test('a held config lock is waited on and never broken, also beside a symlinked config, and only a stale one is taken over', async (t) => {
  const untrustedText = JSON.stringify({ projects: {} }, null, 2);
  const held = await prepareClaudeConfig(t, untrustedText);
  await fs.mkdir(`${held.configPath}.lock`);
  await assert.rejects(held.trust.ensureTrusted(REPOSITORY_ROOT), /another process holds its lock/);
  assert.equal(await fs.readFile(held.configPath, 'utf8'), untrustedText);
  assert.ok((await fs.stat(`${held.configPath}.lock`)).isDirectory());
  assert.ok(held.waits.length > 0);

  const symlinked = await prepareClaudeConfig(t, null);
  const linkTargetPath = path.join(symlinked.configDir, 'linked-claude.json');
  await fs.writeFile(linkTargetPath, untrustedText);
  await fs.symlink(linkTargetPath, symlinked.configPath);
  await fs.mkdir(`${symlinked.configPath}.lock`);
  await assert.rejects(symlinked.trust.ensureTrusted(REPOSITORY_ROOT), /another process holds its lock/);
  assert.equal(await fs.readFile(linkTargetPath, 'utf8'), untrustedText);
  assert.ok(symlinked.waits.length > 0);

  const stale = await prepareClaudeConfig(t, untrustedText);
  await fs.mkdir(`${stale.configPath}.lock`);
  const longAgo = new Date(Date.now() - CLAUDE_CONFIG_LOCK_STALE_MS - 60_000);
  await fs.utimes(`${stale.configPath}.lock`, longAgo, longAgo);
  assert.equal(await stale.trust.ensureTrusted(REPOSITORY_ROOT), 'granted');
  assert.deepEqual(await fs.readdir(stale.configDir), ['.claude.json']);
});

test('the trusted folder is the main checkout that owns the shared git directory', () => {
  assert.equal(repositoryRootOfCommonGitDir('/work/seeded-repo/.git'), '/work/seeded-repo');
  assert.equal(repositoryRootOfCommonGitDir('/srv/git/seeded-repo.git'), null);
  assert.equal(repositoryRootOfCommonGitDir('.git'), null);
});

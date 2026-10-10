import test from 'node:test';
import assert from 'node:assert/strict';

import { readGithubTeams } from '../server/core/github-teams-core.ts';
import { BrowserConfig, Config, ConfigUpdate } from '../shared/contracts/config.ts';

test('shared teams take precedence and deduplicate ignoring case in configured order', () => {
  const config = Config.parse({
    projects: [],
    github: { teams: ['Acme/Core', 'acme/core', 'Other/tools._-2', 'Acme/platform'] },
    teamReview: { org: 'Legacy', team: 'old' },
  });
  assert.deepEqual(readGithubTeams(config), [
    { org: 'Acme', slug: 'Core' },
    { org: 'Other', slug: 'tools._-2' },
    { org: 'Acme', slug: 'platform' },
  ]);
});

test('unset and empty shared teams fall back only to a nonempty legacy org and team', () => {
  for (const github of [undefined, null, {}, { teams: [] }]) {
    assert.deepEqual(readGithubTeams({ github, teamReview: { org: ' Acme ', team: ' core ' } }), [{ org: 'Acme', slug: 'core' }]);
    for (const teamReview of [undefined, null, {}, { org: 'Acme' }, { team: 'core' }, { org: ' ', team: 'core' }, { org: 'Acme', team: ' ' }, { org: 42, team: 'core' }]) {
      assert.deepEqual(readGithubTeams({ github, teamReview }), []);
    }
  }
});

test('file, browser and settings update contracts reject invalid GitHub team segments', () => {
  for (const contract of [Config, BrowserConfig, ConfigUpdate]) {
    for (const github of [undefined, null, {}, { teams: [] }, { teams: ['Acme/team_1.2-3'] }]) {
      const config = contract === Config ? { projects: [], github } : { github };
      assert.equal(contract.safeParse(config).success, true);
    }
    for (const teams of ['Acme/core', [42], [''], ['Acme'], ['/core'], ['Acme/'], ['Acme/core/extra'], ['-Acme/core'], ['Acme/.core'], ['Acme/core team']]) {
      const config = contract === Config ? { projects: [], github: { teams } } : { github: { teams } };
      assert.equal(contract.safeParse(config).success, false, JSON.stringify(teams));
    }
  }
});

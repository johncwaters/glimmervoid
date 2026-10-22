import test from 'node:test';
import assert from 'node:assert/strict';
import { openIncidentName } from '../server/github/core/github-status-core.ts';

test('summary selects the most recently updated open incident and tolerates Statuspage metadata', () => {
  assert.equal(openIncidentName({
    page: { id: 'kctbh9vrtdwd', name: 'GitHub', url: 'https://www.githubstatus.com' },
    status: { indicator: 'minor', description: 'Minor Service Outage' },
    components: [],
    scheduled_maintenances: [],
    incidents: [
      { id: 'closed', name: 'Issues delays', status: 'resolved', updated_at: '2026-10-22T11:00:00Z', impact: 'minor' },
      { id: 'open', name: 'Degraded API requests', status: 'investigating', updated_at: '2026-10-22T10:00:00Z', impact: 'minor' },
      { id: 'older', name: 'Actions delays', status: 'monitoring', updated_at: '2026-10-22T10:30:00+01:00', impact: 'minor' },
    ],
  }), 'Degraded API requests');
});

test('summary without open incidents or with a malformed body has no incident name', () => {
  assert.equal(openIncidentName({ incidents: [] }), null);
  assert.equal(openIncidentName({ incidents: [
    { name: 'API delays', status: 'resolved', updated_at: '2026-10-22T10:00:00Z' },
    { name: 'Actions delays', status: 'postmortem', updated_at: '2026-10-22T11:00:00Z' },
  ] }), null);
});

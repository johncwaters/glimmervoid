import test from 'node:test';
import assert from 'node:assert/strict';

const importCore = () => import('../public/issues-view-core.ts');

const label = (name: string, color = '') => ({ name, color });

const ISSUES = [
  { number: 7, title: 'Citations fail silently', labels: [label('P1'), label('area/ai-assistant'), label('type/bug', 'd73a4a')], assignees: ['alice'], url: '', updatedAt: '' },
  { number: 70, title: 'Budget guard for prd', labels: [label('P2'), label('area/infra')], assignees: [], url: '', updatedAt: '' },
  { number: 117, title: 'Precompute retries', labels: [label('P1'), label('area/precompute'), label('type/bug', 'd73a4a')], assignees: ['bob', 'alice'], url: '', updatedAt: '' },
  { number: 200, title: 'Untagged idea', labels: [label('idea')], url: '', updatedAt: '' },
];

test('filterIssues: an empty filter keeps every issue in order', async () => {
  const { filterIssues, emptyIssueFilter } = await importCore();
  assert.deepEqual(filterIssues(ISSUES, emptyIssueFilter()).map((issue) => issue.number), [7, 70, 117, 200]);
});

test('filterIssues: every search word must match title, label or assignee, case-insensitively', async () => {
  const { filterIssues, emptyIssueFilter } = await importCore();
  const search = (text: string) => filterIssues(ISSUES, { ...emptyIssueFilter(), text }).map((issue) => issue.number);
  assert.deepEqual(search('BUG'), [7, 117]);
  assert.deepEqual(search('bug precompute'), [117]);
  assert.deepEqual(search('alice citations'), [7]);
  assert.deepEqual(search('  '), [7, 70, 117, 200]);
  assert.deepEqual(search('nothing-matches'), []);
});

test('filterIssues: a #number term matches that issue exactly, a bare number matches as text', async () => {
  const { filterIssues, emptyIssueFilter } = await importCore();
  const search = (text: string) => filterIssues(ISSUES, { ...emptyIssueFilter(), text }).map((issue) => issue.number);
  assert.deepEqual(search('#7'), [7]);
  assert.deepEqual(search('#70'), [70]);
  assert.deepEqual(search('7'), [7, 70, 117]);
});

test('filterIssues: label match any is OR, all is AND', async () => {
  const { filterIssues, emptyIssueFilter } = await importCore();
  const byLabels = (labels: string[], labelMatch: 'any' | 'all') => filterIssues(ISSUES, { ...emptyIssueFilter(), labels, labelMatch }).map((issue) => issue.number);
  assert.deepEqual(byLabels(['P1', 'P2'], 'any'), [7, 70, 117]);
  assert.deepEqual(byLabels(['P1', 'P2'], 'all'), []);
  assert.deepEqual(byLabels(['P1', 'type/bug'], 'all'), [7, 117]);
  assert.deepEqual(byLabels(['area/infra', 'idea'], 'any'), [70, 200]);
});

test('filterIssues: assignee filter handles anyone, unassigned and a login', async () => {
  const { filterIssues, emptyIssueFilter, ISSUE_ASSIGNEE_ANYONE, ISSUE_ASSIGNEE_NONE } = await importCore();
  const byAssignee = (assignee: string) => filterIssues(ISSUES, { ...emptyIssueFilter(), assignee }).map((issue) => issue.number);
  assert.deepEqual(byAssignee(ISSUE_ASSIGNEE_ANYONE), [7, 70, 117, 200]);
  assert.deepEqual(byAssignee(ISSUE_ASSIGNEE_NONE), [70, 200]);
  assert.deepEqual(byAssignee('alice'), [7, 117]);
  assert.deepEqual(byAssignee('bob'), [117]);
});

test('filterIssues: search, labels and assignee combine with AND', async () => {
  const { filterIssues } = await importCore();
  const shown = filterIssues(ISSUES, { text: 'retries', labels: ['P1'], labelMatch: 'any', assignee: 'alice' });
  assert.deepEqual(shown.map((issue) => issue.number), [117]);
});

test('toggleIssueLabel adds then removes a label without mutating the filter', async () => {
  const { toggleIssueLabel, emptyIssueFilter } = await importCore();
  const start = emptyIssueFilter();
  const added = toggleIssueLabel(start, 'P1');
  assert.deepEqual(added.labels, ['P1']);
  assert.deepEqual(start.labels, []);
  assert.deepEqual(toggleIssueLabel(added, 'P1').labels, []);
});

test('isIssueFilterActive ignores a whitespace-only search', async () => {
  const { isIssueFilterActive, emptyIssueFilter } = await importCore();
  assert.equal(isIssueFilterActive(emptyIssueFilter()), false);
  assert.equal(isIssueFilterActive({ ...emptyIssueFilter(), text: '   ' }), false);
  assert.equal(isIssueFilterActive({ ...emptyIssueFilter(), text: 'bug' }), true);
  assert.equal(isIssueFilterActive({ ...emptyIssueFilter(), labels: ['P1'] }), true);
  assert.equal(isIssueFilterActive({ ...emptyIssueFilter(), assignee: 'alice' }), true);
});

test('labelFacets groups priority first, prefixed groups next, other last, with counts and short names', async () => {
  const { labelFacets } = await importCore();
  const facets = labelFacets(ISSUES);
  assert.deepEqual(facets.map((facet) => facet.title), ['Priority', 'area', 'type', 'Other']);
  assert.deepEqual(facets[0].labels.map((entry) => [entry.name, entry.count]), [['P1', 2], ['P2', 1]]);
  assert.deepEqual(facets[1].labels.map((entry) => [entry.shortName, entry.count]), [['ai-assistant', 1], ['infra', 1], ['precompute', 1]]);
  assert.deepEqual(facets[2].labels.map((entry) => [entry.name, entry.shortName, entry.color]), [['type/bug', 'bug', 'd73a4a']]);
  assert.deepEqual(facets[3].labels.map((entry) => entry.name), ['idea']);
});

test('labelFacets keeps a selected label visible after it disappears from the issues', async () => {
  const { labelFacets } = await importCore();
  const facets = labelFacets(ISSUES, ['area/gone']);
  const area = facets.find((facet) => facet.group === 'area');
  assert.ok(area);
  assert.deepEqual(area.labels.find((entry) => entry.name === 'area/gone'), { name: 'area/gone', shortName: 'gone', color: '', count: 0 });
});

test('labelGroupOf reads priorities, prefixes and plain labels', async () => {
  const { labelGroupOf } = await importCore();
  assert.equal(labelGroupOf('P0'), 'priority');
  assert.equal(labelGroupOf('p12'), 'priority');
  assert.equal(labelGroupOf('Area/Infra'), 'area');
  assert.equal(labelGroupOf('/leading-slash'), 'other');
  assert.equal(labelGroupOf('bug'), 'other');
});

test('assigneeOptions lists anyone, unassigned, then logins with counts', async () => {
  const { assigneeOptions, ISSUE_ASSIGNEE_ANYONE, ISSUE_ASSIGNEE_NONE } = await importCore();
  assert.deepEqual(assigneeOptions(ISSUES), [
    { value: ISSUE_ASSIGNEE_ANYONE, label: 'Anyone', count: 4 },
    { value: ISSUE_ASSIGNEE_NONE, label: 'Unassigned', count: 2 },
    { value: 'alice', label: 'alice', count: 2 },
    { value: 'bob', label: 'bob', count: 1 },
  ]);
});

test('issuesShownText reads as a total when unfiltered and as a fraction when filtered', async () => {
  const { issuesShownText } = await importCore();
  assert.equal(issuesShownText(1, 1), '1 issue');
  assert.equal(issuesShownText(159, 159), '159 issues');
  assert.equal(issuesShownText(12, 159), 'Showing 12 of 159');
});

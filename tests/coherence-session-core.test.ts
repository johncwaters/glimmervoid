import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoherenceSessionOverrides,
  buildCoherenceShims,
  buildCoherenceUserHooks,
  COHERENCE_HOOK_EVENTS,
  COHERENCE_POST_TOOL_USE_MATCHER,
  decideCoherenceAttachment,
} from '../server/core/coherence-session-core.ts';
import {
  appendJournalWindow, attachedCoherenceHost, COHERENCE_FEED_UNAVAILABLE, nextActionFromRegulateOutput, parseJournalLines, regulateArgs, regulationFromConfig,
  selectLatestShownEntry,
} from '../server/core/coherence-feed-core.ts';
import { judgeCoherenceConfig } from '../server/core/coherence-config-core.ts';
import {
  admitVerbReadings, hasComponentsMap, hasDeclaredMassCommands, parseDecomposeOutput, parseDriftOutput, parseMassOutput, parseRedundancyOutput, summarizeCoherenceTrend,
} from '../server/core/coherence-readings-core.ts';
import { COHERENCE_JOURNAL_DRAWER_MAX_ROWS, COHERENCE_JOURNAL_TEXT_MAX_CHARS, CoherenceReadingRow } from '../shared/contracts/coherence.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';

const nodePath = '/Program Files/node/node';
const hookCliPath = '/installed packages/coherence/hook.js';
const claudeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

test('coherence attachment always includes Factory and gates writers and reviews on the setting', () => {
  const cases = [
    ['factory', false, true],
    ['factory', true, true],
    ['writer', false, false],
    ['writer', true, true],
    ['review', false, false],
    ['review', true, true],
  ] as const;
  for (const [sessionKind, isSettingOn, expected] of cases) {
    assert.equal(decideCoherenceAttachment({ sessionKind, isSettingOn }), expected, `${sessionKind}: setting=${isSettingOn}`);
  }
});

test('coherence hooks match its Claude bundle with a matcher only on PostToolUse', () => {
  const hooks = buildCoherenceUserHooks({ nodePath, hookCliPath });
  assert.deepEqual(COHERENCE_HOOK_EVENTS, ['SubagentStart', 'SessionStart', 'SubagentStop', 'Stop', 'PostToolUse']);
  assert.equal(COHERENCE_POST_TOOL_USE_MATCHER, 'Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit');
  assert.deepEqual(hooks.map((hook) => hook.event), [...COHERENCE_HOOK_EVENTS, 'SessionStart']);
  assert.deepEqual(hooks.map((hook) => hook.id), [
    'coherence-subagent-start', 'coherence-session-start', 'coherence-subagent-stop', 'coherence-stop', 'coherence-post-tool-use',
    'coherence-cli-on-path',
  ]);
  assert.deepEqual(hooks.at(-1), {
    id: 'coherence-cli-on-path',
    name: 'Coherence CLI on PATH',
    event: 'SessionStart',
    type: 'command',
    enabled: true,
    command: 'echo In this Glimmervoid session coherence is on PATH, so run coherence followed by the verb wherever the Coherence instructions say npx coherence.',
  });
  for (const hook of hooks.slice(0, -1)) {
    assert.equal(hook.type, 'command');
    assert.equal(hook.enabled, true);
    assert.equal(hook.name, `Coherence ${hook.event}`);
    assert.equal(hook.command, `"${nodePath}" "${hookCliPath}" ${hook.event}`);
    if (hook.event === 'PostToolUse') {
      assert.equal(hook.matcher, COHERENCE_POST_TOOL_USE_MATCHER);
      continue;
    }
    assert.equal('matcher' in hook, false);
  }
});

test('coherence hook commands quote Windows paths without changing backslashes', () => {
  const hooks = buildCoherenceUserHooks({ nodePath: 'C:\\Program Files\\node.exe', hookCliPath: 'C:\\Coherence tools\\hook.js' });
  assert.equal(hooks[0].command, '"C:\\Program Files\\node.exe" "C:\\Coherence tools\\hook.js" SubagentStart');
});

test('coherence hook commands reject a double quote in either path', () => {
  assert.throws(() => buildCoherenceUserHooks({ nodePath: '/bad"node', hookCliPath }), /double quotes/);
  assert.throws(() => buildCoherenceUserHooks({ nodePath, hookCliPath: '/bad"hook.js' }), /double quotes/);
});

test('coherence Factory overrides preassign the conversation and carry only the PATH note and shim, never a hook bundle', () => {
  const shimDir = '/glimmervoid home/factory/bin';
  assert.deepEqual(buildCoherenceSessionOverrides({ claudeSessionId, shimDir }), {
    extraClaudeArgs: ['--session-id', claudeSessionId],
    extraUserHooks: buildCoherenceUserHooks({ nodePath, hookCliPath }).filter((hook) => hook.id === 'coherence-cli-on-path'),
    prependPathDirs: [shimDir],
  });
});

test('coherence session overrides reject non-UUID conversation ids', () => {
  for (const invalidId of ['', 'not-a-uuid', '--resume', `${claudeSessionId}extra`, ` ${claudeSessionId}`]) {
    assert.throws(() => buildCoherenceSessionOverrides({ claudeSessionId: invalidId, shimDir: '/bin' }), /UUID/);
  }
});

test('coherence shims quote paths, forward arguments and use platform-specific modes and newlines', () => {
  const cliPath = '/installed packages/coherence/cli.js';
  assert.deepEqual(buildCoherenceShims({ nodePath, cliPath }), [
    { fileName: 'coherence', mode: 0o755, text: `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n` },
    { fileName: 'coherence.cmd', mode: 0o644, text: `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n` },
  ]);
});

test('coherence shims preserve Windows paths and reject double quotes in either path', () => {
  const shims = buildCoherenceShims({ nodePath: 'C:\\Program Files\\node.exe', cliPath: 'C:\\Coherence tools\\cli.js' });
  assert.equal(shims[1].text, '@echo off\r\n"C:\\Program Files\\node.exe" "C:\\Coherence tools\\cli.js" %*\r\n');
  assert.throws(() => buildCoherenceShims({ nodePath: '/bad"node', cliPath: '/cli.js' }), /double quotes/);
  assert.throws(() => buildCoherenceShims({ nodePath, cliPath: '/bad"cli.js' }), /double quotes/);
});

test('the coherence feed shows the latest unretracted entry, maps one regulate next action and refuses the team review config rule', () => {
  const session = '11111111-2222-4333-8444-555555555555';
  const row = (id: string, at: string, kind: string, extra: Record<string, string> = {}) => JSON.stringify({ id, at, kind, session, chose: `chose ${id}\u0007`, because: 'why', ...extra });
  const decisions = parseJournalLines([
    row('d-00000001', '2026-10-17T10:00:00.000Z', 'decision'),
    row('d-00000002', '2026-10-17T10:01:00.000Z', 'conjecture'),
    row('d-00000003', '2026-10-17T10:02:00.000Z', 'retraction', { supersedes: 'd-00000002' }),
    row('d-00000004', '2026-10-17T10:03:00.000Z', 'decision', { session: 'someone-else' }),
    JSON.stringify({ id: '../../etc/passwd', at: '2026-10-17T10:04:00.000Z', kind: 'decision', session, chose: 'x', because: 'y' }),
    '{not json',
  ].join('\n'), 'decisions', session);
  assert.deepEqual(decisions.map((entry) => entry.id), ['d-00000001', 'd-00000002', 'd-00000003']);
  assert.equal(decisions[0].text, 'chose d-00000001');
  assert.equal(selectLatestShownEntry(appendJournalWindow([], decisions))?.id, 'd-00000001');
  const defects = parseJournalLines(JSON.stringify({ event: 'recorded', id: 'def-0123456789ab', at: '2026-10-17T10:05:00.000Z', session, summary: 'x'.repeat(5000), evidence: 'seen' }), 'defects', session);
  const window = appendJournalWindow(appendJournalWindow([], decisions), defects);
  assert.equal(selectLatestShownEntry(window)?.kind, 'defect');
  assert.equal(selectLatestShownEntry(window)?.text.length, COHERENCE_JOURNAL_TEXT_MAX_CHARS);
  assert.equal(appendJournalWindow([], Array.from({ length: 250 }, (_, index) => ({ ...decisions[0], id: `d-${String(index).padStart(8, '0')}` }))).length, COHERENCE_JOURNAL_DRAWER_MAX_ROWS);

  const refused = nextActionFromRegulateOutput(JSON.stringify({
    doctrine: 'coherence', id: 'r-1', action: 'require-decision', host: 'claude', scope: {}, remaining: 2,
    selected: { rule: 'significant-growth', evidence: 'surface +4\nexports', command: { name: 'decide', args: ['"no invariant"'] } },
  }));
  assert.deepEqual(refused, { ok: true, nextAction: { action: 'require-decision', rule: 'significant-growth', evidence: 'surface +4 exports', remedy: null, command: 'coherence decide "no invariant"', remaining: 2 } });
  assert.deepEqual(nextActionFromRegulateOutput('Unrunnable: boom'), { ok: false, reason: COHERENCE_FEED_UNAVAILABLE.unrecognized });
  assert.deepEqual(regulateArgs({ host: 'claude', baseSha: 'a'.repeat(40) }), ['regulate', '--json', '--since', 'a'.repeat(40), '--host', 'claude']);
  assert.deepEqual(regulateArgs({ host: 'claude', baseSha: '--upload-pack=x' }), ['regulate', '--json', '--host', 'claude']);

  assert.equal(regulationFromConfig({ kind: 'file', text: '{}' }), null);
  assert.deepEqual(regulationFromConfig({ kind: 'file', text: '{"language":"./evil.js"}' }), judgeCoherenceConfig({ kind: 'file', text: '{"language":"./evil.js"}' }));
  assert.equal(regulationFromConfig({ kind: 'symlink' })?.ok, false);
  assert.equal(attachedCoherenceHost({ host: 'claude', coherenceHooks: null }), null);
  assert.equal(attachedCoherenceHost({ host: 'claude', coherenceHooks: { active: false, reason: 'control files missing' } }), null);
  assert.equal(attachedCoherenceHost({ host: 'claude', coherenceHooks: { active: true } }), 'claude');
  assert.equal(attachedCoherenceHost({ host: 'grok', coherenceHooks: { active: true } }), null);
});

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const DRIFT_OUTPUT = `direction ${EM_DASH} architectural trajectory (where is the agent driving?)
  14 development commits · 7 windows · oldest → newest

  LOCALITY   ▁▃▃▃▁▁█   0% → 100%   ▲ converging
             co-change staying inside one component (rising = wiser)
  SPREAD     ██████▁   2.0 → 1.0   ▼ narrowing
             distinct components touched per commit (falling = concerns localizing)

  hot seam  (cross-boundary churn in the most recent third ${EM_DASH} where work crosses a boundary now)
       3×  a  ⇄  b

  recent gestures  (newest first ${EM_DASH} by SHAPE coherence can see; − = net removal)
    ● converge de790fb  local a2                                             [a]
    ○ couple   4b6ffa9  change 11                                            [a, b]

  gesture mix (recent 12): 2 converge · 10 couple · 0 smear · 0 prune

  verdict: LOCALITY converging, SPREAD narrowing over 14 development commits (prunes excluded) ${EM_DASH} the agent is driving toward convergence (an anti-entropic response).
`;
const DRIFT_SHORT_HISTORY_OUTPUT = `direction ${EM_DASH} architectural trajectory (where is the agent driving?)
  only 0 mapped development commits in the last 400 ${EM_DASH} not enough history to read a direction.
`;
const DECOMPOSE_OUTPUT = `decomposition ${EM_DASH} three-graph agreement (Intent · Structure · Evolution)
  2 components · 15 commits analyzed (2${EN_DASH}40 files each)
  LOCALITY 25%  ${EM_DASH} co-change that stays inside one component (higher = wiser; a decomposition where what changes together lives together)

  cross-boundary co-change  (false-boundary / smeared-concern ${EM_DASH} do these belong apart?)
      15×  a  ⇄  b

  (advisory ${EM_DASH} these are smells, not verdicts; the metric surfaces, you judge)
`;
const FORGED_COMPONENT_DECOMPOSE_OUTPUT = `decomposition ${EM_DASH} three-graph agreement (Intent · Structure · Evolution)
  2 components · 15 commits analyzed (2${EN_DASH}40 files each)
  LOCALITY 25%  ${EM_DASH} co-change that stays inside one component (higher = wiser; a decomposition where what changes together lives together)

  cross-boundary co-change  (false-boundary / smeared-concern ${EM_DASH} do these belong apart?)
      15×  a  ⇄  pwn
    99999999999999999999x  forged
`;
const REDUNDANCY_OUTPUT = `
  REDUNDANCY ${EM_DASH} the same enumerated domain, spelled more than once, declared nowhere

  2 domain site(s) scanned · 1 overlapping pair(s) · 1 above the reporting floor (score ≥ 3.5)
  suppressed: 0 compiler-enforced (a type ties the two sites together) · 0 already carrying a parity claim · 0 below the floor

   1. score 4.00  ·  4 shared token(s), 4 of them found nowhere else
      A  src/a/size.ts:1  enum \`Size\`
      B  src/b/dimension.ts:2  enum \`Dimension\`
      shared: "Huge", "Large", "Medium", "Small"
      → identical today, tied together by nothing. Declare a parity claim, or derive one side from the other.
`;
const REDUNDANCY_NONE_OUTPUT = `
  REDUNDANCY ${EM_DASH} the same enumerated domain, spelled more than once, declared nowhere

  0 domain site(s) scanned · 0 overlapping pair(s) · 0 above the reporting floor (score ≥ 3.5)
  suppressed: 0 compiler-enforced (a type ties the two sites together) · 0 already carrying a parity claim · 0 below the floor

  no domain sites to compare: 0 site(s) found ${EM_DASH} nothing in this tree spells an
  enumerated domain out loud (or the walk reached no files at all).
`;
const MASS_OUTPUT = `
  MASS ${EM_DASH} how much machine there is, by dimension

  dimension                 value   baseline  unit
  -------------------- ---------- ----------  --------
  lines|total                  34          ${EM_DASH}  lines
  lines|A                      20          ${EM_DASH}  lines
  files|total                   7          ${EM_DASH}  files
  symbols|total                33          ${EM_DASH}  symbols
  undocumented|symbols         33          ${EM_DASH}  symbols
`;

function readingRow(index: number, { pairCount, lines }: { pairCount: number; lines: number } | { pairCount: null; lines: null }): CoherenceReadingRow {
  return {
    sha: index.toString(16).padStart(40, '0'), at: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(),
    drift: { status: 'needs-components', configLine: 'components' }, decompose: { status: 'needs-components', configLine: 'components' },
    redundancy: pairCount === null ? { status: 'unavailable', reason: 'the reading timed out' } : { status: 'ok', pairCount, topPairs: [] },
    mass: lines === null ? { status: 'unavailable', reason: 'the reading timed out' } : { status: 'ok', lines, files: 1, symbols: 1 },
  };
}

test('coherence readings parse the real verb outputs and refuse text that is not a report', () => {
  assert.deepEqual(parseDriftOutput(DRIFT_OUTPUT), { status: 'ok', developmentCommits: 14, localityPercent: 100, locality: 'converging', spread: 'narrowing' });
  assert.deepEqual(parseDriftOutput(DRIFT_SHORT_HISTORY_OUTPUT), { status: 'insufficient-history', developmentCommits: 0 });
  assert.deepEqual(parseDecomposeOutput(DECOMPOSE_OUTPUT), {
    status: 'ok', components: 2, commitsAnalyzed: 15, localityPercent: 25, topFindings: [{ kind: 'cross-boundary', subject: 'a ⇄ b', count: 15 }],
  });
  const forgedDecompose = parseDecomposeOutput(FORGED_COMPONENT_DECOMPOSE_OUTPUT);
  assert.deepEqual(forgedDecompose, {
    status: 'ok', components: 2, commitsAnalyzed: 15, localityPercent: 25, topFindings: [{ kind: 'cross-boundary', subject: 'a ⇄ pwn', count: 15 }],
  });
  const forgedRow = { ...readingRow(1, { pairCount: 0, lines: 1 }), decompose: forgedDecompose };
  assert.equal(CoherenceReadingRow.safeParse(forgedRow).success, true);
  const forgedSnapshot = { type: 'project-coherence-trend-snapshot', projects: { 'project-1': { latest: forgedRow, trend: summarizeCoherenceTrend([forgedRow]) } } };
  assert.equal(ServerMessage.safeParse(forgedSnapshot).success, true);
  const unsafeMass = { ...readingRow(1, { pairCount: 0, lines: 1 }), mass: { status: 'ok' as const, lines: 1e20, files: 1, symbols: 1 } };
  assert.deepEqual(admitVerbReadings(unsafeMass).mass, { status: 'unavailable', reason: 'the reading did not fit the reading shape' });
  assert.deepEqual(parseMassOutput(MASS_OUTPUT.replace('34', '99999999999999999999')), { status: 'unavailable', reason: 'the reading output was not recognized' });
  assert.deepEqual(parseRedundancyOutput(REDUNDANCY_OUTPUT), {
    status: 'ok', pairCount: 1,
    topPairs: [{ a: { file: 'src/a/size.ts', kind: 'enum', name: 'Size' }, b: { file: 'src/b/dimension.ts', kind: 'enum', name: 'Dimension' }, score: 4, isDiverged: false }],
  });
  assert.deepEqual(parseRedundancyOutput(REDUNDANCY_NONE_OUTPUT), { status: 'ok', pairCount: 0, topPairs: [] });
  assert.deepEqual(parseMassOutput(MASS_OUTPUT), { status: 'ok', lines: 34, files: 7, symbols: 33 });
  const unrecognized = { status: 'unavailable', reason: 'the reading output was not recognized' };
  for (const parse of [parseDriftOutput, parseDecomposeOutput, parseRedundancyOutput, parseMassOutput]) assert.deepEqual(parse('Error: no coherence.config.json'), unrecognized);
  assert.equal(hasComponentsMap('{}'), false);
  assert.equal(hasComponentsMap('{"components":[]}'), false);
  assert.equal(hasComponentsMap('{"components":[{"name":"billing","files":["src/billing/**"]}]}'), true);
  assert.equal(hasDeclaredMassCommands('{"mass":{"measures":[]}}'), false);
  assert.equal(hasDeclaredMassCommands('{"mass":{"measures":[{"key":"pwn","cmd":["sh","-c","touch MARKER"]}]}}'), true);
});

test('the coherence trend compares redundant pairs per thousand lines across the last twenty comparable rows', () => {
  assert.equal(summarizeCoherenceTrend([readingRow(1, { pairCount: 1, lines: 1000 })]).direction, 'steady');
  assert.deepEqual(summarizeCoherenceTrend([readingRow(1, { pairCount: 1, lines: 1000 }), readingRow(2, { pairCount: null, lines: null }), readingRow(3, { pairCount: 2, lines: 1000 })]), {
    direction: 'decohering', rows: 3, comparedRows: 2, redundancyPairs: { from: 1, to: 2 }, lines: { from: 1000, to: 1000 },
  });
  assert.equal(summarizeCoherenceTrend([readingRow(1, { pairCount: 2, lines: 1000 }), readingRow(2, { pairCount: 2, lines: 2000 })]).direction, 'converging');
  assert.equal(summarizeCoherenceTrend([readingRow(1, { pairCount: 10, lines: 1000 }), readingRow(2, { pairCount: 10, lines: 1050 })]).direction, 'steady');
  assert.equal(summarizeCoherenceTrend([readingRow(1, { pairCount: 0, lines: 10 }), readingRow(2, { pairCount: 0, lines: 900 })]).direction, 'steady');
  const longSeries = [readingRow(0, { pairCount: 50, lines: 1000 }), ...Array.from({ length: 20 }, (_, index) => readingRow(index + 1, { pairCount: 1, lines: 1000 }))];
  assert.deepEqual(summarizeCoherenceTrend(longSeries), { direction: 'steady', rows: 20, comparedRows: 20, redundancyPairs: { from: 1, to: 1 }, lines: { from: 1000, to: 1000 } });
});

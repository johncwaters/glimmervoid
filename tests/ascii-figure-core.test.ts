import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMeterTrack, renderTable } from '../server/core/ascii-figure-core.ts';

test('headed table centers its title and right-aligns numeric cells above a rule', () => {
  assert.equal(renderTable({
    title: 'Packs',
    headers: ['NAME', 'COUNT'],
    rows: [['aa', '7']],
    terminalColumns: 20,
  }), [
    '+--- [ PACKS ] ----+',
    `| ${' '.repeat(16)} |`,
    '| NAME | COUNT     |',
    '| -----+------     |',
    '| aa   |     7     |',
    `| ${' '.repeat(16)} |`,
    '+------------------+',
  ].join('\n'));
});

test('headerless table left-aligns every column with two spaces and no rule', () => {
  assert.equal(renderTable({
    title: 'Status',
    rows: [['node', 'loads OK'], ['build', 'yes']],
    terminalColumns: 20,
  }), [
    '+--- [ STATUS ] ---+',
    `| ${' '.repeat(16)} |`,
    '| node   loads OK  |',
    '| build  yes       |',
    `| ${' '.repeat(16)} |`,
    '+------------------+',
  ].join('\n'));
});

test('meter track fills and clamps to its tick count', () => {
  assert.equal(renderMeterTrack(0, 12), '[------------]');
  assert.equal(renderMeterTrack(0.5, 12), '[======------]');
  assert.equal(renderMeterTrack(1, 12), '[============]');
  assert.equal(renderMeterTrack(1.5, 12), '[============]');
  assert.equal(renderMeterTrack(-1, 12), '[------------]');
});

test('non-ASCII cell padding aligns the frame by code-point width', () => {
  const label = `caf${String.fromCharCode(0xe9)}`;
  const lines = renderTable({
    title: 'Names',
    rows: [[label, 'one'], ['tea', 'two']],
    terminalColumns: 20,
  }).split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => Array.from(line).length === 20));
  assert.equal(lines[2], `| ${label}  one${' '.repeat(7)} |`);
});

test('narrow terminal shrinks a short table and never truncates a long cell', () => {
  const short = renderTable({ title: 'A', rows: [['x']], terminalColumns: 20 });
  assert.ok(short.split('\n').every((line) => Array.from(line).length === 20));
  const longCell = 'a'.repeat(30);
  const long = renderTable({ title: 'A', rows: [[longCell]], terminalColumns: 20 });
  assert.match(long, new RegExp(longCell));
  assert.ok(long.split('\n').every((line) => Array.from(line).length === 34));
});

test('missing and non-finite terminal widths use the default width', () => {
  const options = { title: 'Default', rows: [['value']] };
  const expected = renderTable(options);
  assert.equal(renderTable({ ...options, terminalColumns: Number.NaN }), expected);
  assert.equal(renderTable({ ...options, terminalColumns: Number.POSITIVE_INFINITY }), expected);
  assert.ok(expected.split('\n').every((line) => Array.from(line).length === 52));
});

test('multi-line cell renders as continuation rows inside the frame', () => {
  const lines = renderTable({
    title: 'Doctor',
    rows: [['reason', 'Cannot find module\nRequire stack:\r\n- /tmp/loader.js'], ['build', 'yes']],
    terminalColumns: 20,
  }).split('\n');
  const frameWidth = Array.from(lines[0] ?? '').length;
  assert.ok(lines.every((line) => Array.from(line).length === frameWidth));
  assert.ok(lines.every((line) => line.startsWith('|') || line.startsWith('+')));
  assert.ok(lines.some((line) => line.startsWith(`| ${' '.repeat(6)}  Require stack:`)));
  assert.ok(lines.some((line) => line.startsWith(`| ${' '.repeat(6)}  - /tmp/loader.js`)));
  assert.equal(lines.length, 8);
});

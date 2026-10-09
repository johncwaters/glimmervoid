import test from 'node:test';
import assert from 'node:assert/strict';

import {
  byteSizeText,
  clockDurationText,
  COMPACT_FLOORED_AGO,
  elapsedText,
  localClockText,
  localDayKey,
  localHourMinuteText,
  pad2,
  twoUnitDurationText,
} from '../shared/display-text.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('elapsedText rounding floors or rounds the elapsed seconds', () => {
  const plain = { wording: 'compact', suffix: '', justNowBelowSeconds: 0 } as const;
  assert.equal(elapsedText(59_600, { ...plain, rounding: 'floor' }), '59s');
  assert.equal(elapsedText(59_600, { ...plain, rounding: 'round' }), '1m');
});

test('elapsedText clamps a negative elapsed time to zero', () => {
  assert.equal(elapsedText(-5 * SECOND, COMPACT_FLOORED_AGO), '0s ago');
});

test('elapsedText compact wording climbs seconds, minutes, hours, days', () => {
  assert.equal(elapsedText(45 * SECOND, COMPACT_FLOORED_AGO), '45s ago');
  assert.equal(elapsedText(90 * SECOND, COMPACT_FLOORED_AGO), '1m ago');
  assert.equal(elapsedText(2 * HOUR, COMPACT_FLOORED_AGO), '2h ago');
  assert.equal(elapsedText(2 * DAY, COMPACT_FLOORED_AGO), '2d ago');
});

test('elapsedText abbreviated wording uses min and hr and pluralizes days', () => {
  const abbreviated = { rounding: 'floor', wording: 'abbreviated', suffix: ' ago', justNowBelowSeconds: 0 } as const;
  assert.equal(elapsedText(30 * SECOND, abbreviated), '30 sec ago');
  assert.equal(elapsedText(5 * MINUTE, abbreviated), '5 min ago');
  assert.equal(elapsedText(3 * HOUR, abbreviated), '3 hr ago');
  assert.equal(elapsedText(DAY, abbreviated), '1 day ago');
  assert.equal(elapsedText(4 * DAY, abbreviated), '4 days ago');
});

test('elapsedText spelled wording pluralizes every unit', () => {
  const spelled = { rounding: 'floor', wording: 'spelled', suffix: '', justNowBelowSeconds: 0 } as const;
  assert.equal(elapsedText(SECOND, spelled), '1 second');
  assert.equal(elapsedText(2 * SECOND, spelled), '2 seconds');
  assert.equal(elapsedText(MINUTE, spelled), '1 minute');
  assert.equal(elapsedText(HOUR, spelled), '1 hour');
  assert.equal(elapsedText(5 * HOUR, spelled), '5 hours');
  assert.equal(elapsedText(3 * DAY, spelled), '3 days');
});

test('elapsedText suffix is appended verbatim', () => {
  assert.equal(elapsedText(5 * SECOND, { ...COMPACT_FLOORED_AGO, suffix: '' }), '5s');
  assert.equal(elapsedText(5 * SECOND, { ...COMPACT_FLOORED_AGO, suffix: ' later' }), '5s later');
});

test('elapsedText reads just now below the threshold and never at zero threshold', () => {
  const justNow = { ...COMPACT_FLOORED_AGO, justNowBelowSeconds: 60 };
  assert.equal(elapsedText(59 * SECOND, justNow), 'just now');
  assert.equal(elapsedText(60 * SECOND, justNow), '1m ago');
  assert.equal(elapsedText(0, COMPACT_FLOORED_AGO), '0s ago');
});

test('twoUnitDurationText with smallest unit seconds always shows the remainder', () => {
  const uptime = { smallestUnit: 's', dropsZeroRemainder: false } as const;
  assert.equal(twoUnitDurationText(42, uptime), '42s');
  assert.equal(twoUnitDurationText(300, uptime), '5m 0s');
  assert.equal(twoUnitDurationText(3725, uptime), '1h 2m');
  assert.equal(twoUnitDurationText(7200, uptime), '2h 0m');
});

test('twoUnitDurationText with smallest unit minutes drops a zero remainder when asked', () => {
  const minutes = { smallestUnit: 'm', dropsZeroRemainder: true } as const;
  assert.equal(twoUnitDurationText(42, minutes), '0m');
  assert.equal(twoUnitDurationText(45 * 60, minutes), '45m');
  assert.equal(twoUnitDurationText(120 * 60, minutes), '2h');
  assert.equal(twoUnitDurationText(135 * 60, minutes), '2h 15m');
  assert.equal(twoUnitDurationText(300, { smallestUnit: 's', dropsZeroRemainder: true }), '5m');
});

test('clockDurationText shows hours only when asked and non-zero', () => {
  assert.equal(clockDurationText(65 * SECOND, { rounding: 'floor', showsHours: true }), '1:05');
  assert.equal(clockDurationText(HOUR + 2 * MINUTE + 3 * SECOND, { rounding: 'floor', showsHours: true }), '1:02:03');
  assert.equal(clockDurationText(HOUR + 2 * MINUTE + 3 * SECOND, { rounding: 'floor', showsHours: false }), '62:03');
});

test('clockDurationText rounding floors or rounds the seconds', () => {
  assert.equal(clockDurationText(1_600, { rounding: 'floor', showsHours: false }), '0:01');
  assert.equal(clockDurationText(1_600, { rounding: 'round', showsHours: false }), '0:02');
  assert.equal(clockDurationText(-1_000, { rounding: 'round', showsHours: false }), '0:00');
});

test('byteSizeText climbs units up to the largest unit asked for', () => {
  assert.equal(byteSizeText(512, 'GB'), '512 B');
  assert.equal(byteSizeText(1536, 'GB'), '1.5 KB');
  assert.equal(byteSizeText(5 * 1024 * 1024, 'GB'), '5.0 MB');
  assert.equal(byteSizeText(3 * 1024 * 1024 * 1024, 'GB'), '3.00 GB');
  assert.equal(byteSizeText(512, 'KB'), '512 B');
  assert.equal(byteSizeText(5 * 1024 * 1024, 'KB'), '5120.0 KB');
});

test('pad2 pads single digits to two', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(12), '12');
});

test('localDayKey reads the local calendar day from a date or a timestamp', () => {
  const date = new Date(2026, 0, 5, 12);
  assert.equal(localDayKey(date), '2026-01-05');
  assert.equal(localDayKey(date.getTime()), '2026-01-05');
});

test('localHourMinuteText pads local hours and minutes', () => {
  assert.equal(localHourMinuteText(new Date(2026, 0, 5, 7, 4)), '07:04');
});

test('localClockText matches the two-digit locale time string', () => {
  const date = new Date(2026, 0, 5, 7, 4, 9);
  assert.equal(localClockText(date), date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
});

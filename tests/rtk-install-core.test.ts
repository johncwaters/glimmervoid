import test from 'node:test';
import assert from 'node:assert/strict';

import { findEscapingArchiveMember } from '../server/core/rtk-install-core.ts';

test('findEscapingArchiveMember flags parent-dir and absolute members and passes a nested rtk', () => {
  assert.equal(findEscapingArchiveMember('./\n./rtk-0.45.0/\n./rtk-0.45.0/rtk\n'), null);
  assert.equal(findEscapingArchiveMember('rtk\n../evil\n'), '../evil');
  assert.equal(findEscapingArchiveMember('/usr/bin/rtk\n'), '/usr/bin/rtk');
  assert.equal(findEscapingArchiveMember('C:\\Windows\\rtk.exe\n'), 'C:\\Windows\\rtk.exe');
  assert.equal(findEscapingArchiveMember(''), null);
});

import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv } from 'node:util';

import { upsertEnvLines } from '../server/secrets/core/env-file-core.ts';

const OLDER_KEY = '-----BEGIN KEY-----\nolder-key-material\n-----END KEY-----';
const NEWER_KEY = '-----BEGIN KEY-----\nnewer-key-material\n-----END KEY-----';

test('a multi-line value delivered over an older one leaves no line of the older value', () => {
  const firstText = upsertEnvLines('KEEP=1\n', { PRIVATE_KEY: OLDER_KEY });
  const secondText = upsertEnvLines(`${firstText}AFTER=2\n`, { PRIVATE_KEY: NEWER_KEY });
  assert.equal(secondText.includes('older-key-material'), false);
  assert.deepEqual({ ...parseEnv(secondText) }, { KEEP: '1', PRIVATE_KEY: NEWER_KEY, AFTER: '2' });
});

test('a name that is also a line inside another multi-line value is delivered as its own variable', () => {
  const notes = 'first line\nAPI_KEY=not-an-assignment\nlast line';
  const existingText = upsertEnvLines('', { NOTES: notes });
  const updatedText = upsertEnvLines(existingText, { API_KEY: 'delivered-value' });
  assert.deepEqual({ ...parseEnv(updatedText) }, { NOTES: notes, API_KEY: 'delivered-value' });
});

test('a value holding an apostrophe is written in double quotes', () => {
  const text = upsertEnvLines('', { PHRASE: "it's here" });
  assert.equal(text, 'PHRASE="it\'s here"\n');
  assert.deepEqual({ ...parseEnv(text) }, { PHRASE: "it's here" });
});

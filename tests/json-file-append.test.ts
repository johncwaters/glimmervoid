import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendJsonLine } from '../server/json-file.ts';

function tempFile(name: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-append-'));
  return { dir, filePath: path.join(dir, name) };
}

function parsedField(filePath: string, field: string): unknown[] {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || !(field in record)) return null;
      return record[field as keyof typeof record];
    });
}

test('concurrent appends to one path land whole and in call order', async () => {
  const { dir, filePath } = tempFile('canon-202608.jsonl');
  try {
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 50; index += 1) {
      writes.push(appendJsonLine(filePath, { index, filler: 'x'.repeat(1024) }, { mkdir: true }));
    }
    await Promise.all(writes);
    assert.equal(fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length, 50);
    assert.deepEqual(parsedField(filePath, 'index'), writes.map((_value, index) => index));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

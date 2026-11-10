import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { Op } from '../shared/contracts/whiteboard.ts';
import { applyOps, createBoard } from '../shared/whiteboard-ops-core.ts';

const fixturesDirectory = path.resolve(import.meta.dirname, '../harness/site-capture/fixtures');
const actor = { id: 'site-capture', name: 'site-capture' };
const BoardSeed = z.object({ id: z.string(), title: z.string(), ops: z.array(Op) });

function readOps(relativePath: string): z.infer<typeof Op>[] {
  return z.array(Op).parse(JSON.parse(fs.readFileSync(path.join(fixturesDirectory, relativePath), 'utf8')));
}

for (const ruleFile of ['half-up.json', 'half-even.json']) {
  test(`the demo invoice board accepts the add-rounding put then ${ruleFile}`, () => {
    const seed = BoardSeed.parse(JSON.parse(fs.readFileSync(path.join(fixturesDirectory, 'demo-board.json'), 'utf8')));
    const seeded = applyOps(createBoard({ id: seed.id, title: seed.title, nowMs: 1 }), seed.ops, actor, 1);
    assert.ok(seeded.ok, seeded.ok ? '' : seeded.error);
    const rounded = applyOps(seeded.board, readOps('demo/billing/board/add-rounding.json'), actor, 2);
    assert.ok(rounded.ok, rounded.ok ? '' : rounded.error);
    const ruled = applyOps(rounded.board, readOps(`demo/billing/board/${ruleFile}`), actor, 3);
    assert.ok(ruled.ok, ruled.ok ? '' : ruled.error);
  });
}

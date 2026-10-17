import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ANIMAL_SPRITES_DIRECTORY, renderAnimalSprites } from '../scripts/generate-animal-sprites.ts';

test('every committed animal sprite PNG matches its pixel source, so run npm run animals:build after editing one', () => {
  const renderedPngBytesByFileName = renderAnimalSprites();
  const committedPngFileNames = fs.readdirSync(ANIMAL_SPRITES_DIRECTORY).filter((fileName) => fileName.endsWith('.png')).sort();
  assert.deepEqual(committedPngFileNames, [...renderedPngBytesByFileName.keys()].sort());
  for (const [fileName, renderedPngBytes] of renderedPngBytesByFileName) {
    assert.ok(renderedPngBytes.equals(fs.readFileSync(path.join(ANIMAL_SPRITES_DIRECTORY, fileName))), `${fileName} is stale`);
  }
});

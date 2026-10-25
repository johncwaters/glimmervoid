import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ANIMAL_SPRITES_DIRECTORY, readAnimalSpriteSources, renderAnimalSprites } from '../../scripts/generate-animal-sprites.ts';

test('every committed animal sprite PNG matches its pixel source, so run npm run animals:build after editing one', () => {
  const renderedPngBytesByFileName = renderAnimalSprites();
  const committedPngFileNames = fs.readdirSync(ANIMAL_SPRITES_DIRECTORY).filter((fileName) => fileName.endsWith('.png')).sort();
  assert.deepEqual(committedPngFileNames, [...renderedPngBytesByFileName.keys()].sort());
  for (const [fileName, renderedPngBytes] of renderedPngBytesByFileName) {
    assert.ok(renderedPngBytes.equals(fs.readFileSync(path.join(ANIMAL_SPRITES_DIRECTORY, fileName))), `${fileName} is stale`);
  }
});

test('every animal sprite has six frames with real motion, at most eight colors and a clear two-pixel margin for its baked outline and halo', () => {
  const outlineAndHaloWidthPx = 2;
  for (const [name, source] of readAnimalSpriteSources()) {
    assert.ok(source.haloColor, `${name} declares no halo, so it vanishes on the dark themes`);
    if (!name.startsWith('sprite-')) continue;
    assert.ok(source.outlineColor, `${name} declares no outline, so it vanishes on the light themes`);
    const distinctFrameCount = new Set(source.frames.map((rows) => rows.join('\n'))).size;
    assert.ok(source.frames.length === 6 && distinctFrameCount >= 4, `${name} needs six frames, at least four of them distinct, so it visibly moves`);
    assert.ok(source.colorsBySymbol.size <= 8, `${name} uses ${source.colorsBySymbol.size} colors`);
    for (const rows of source.frames) {
      const frameHeightPx = rows.length;
      const frameWidthPx = rows[0].length;
      for (const [y, row] of rows.entries()) {
        for (const [x, symbol] of [...row].entries()) {
          const isInsideMargin = x >= outlineAndHaloWidthPx && y >= outlineAndHaloWidthPx && x < frameWidthPx - outlineAndHaloWidthPx && y < frameHeightPx - outlineAndHaloWidthPx;
          assert.ok(symbol === '.' || isInsideMargin, `${name} draws at ${x},${y}, where the outline and halo would be clipped`);
        }
      }
    }
  }
});

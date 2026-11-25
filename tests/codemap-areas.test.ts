import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodemapService } from '../server/codemap/codemap-wiring.ts';
import { createStudioReposStore } from '../server/board-session/studio-repos-store.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import type { Board } from '../shared/contracts/whiteboard.ts';
import { openWhiteboardWiring } from './helpers/whiteboard-closables.ts';

const BOX_WIDTH = 220;

function writeLibAndApp(folderDir: string): void {
  const writeSource = (repoPath: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(folderDir, repoPath)), { recursive: true });
    fs.writeFileSync(path.join(folderDir, repoPath), text);
  };
  for (let index = 0; index < 21; index++) writeSource(`lib/part${index}.ts`, `export const part${index} = ${index};`);
  for (let index = 0; index < 20; index++) writeSource(`app/screen${index}.ts`, `import { part${index} } from '../lib/part${index}.ts';\nexport const screen${index} = part${index};`);
}

async function createRepo(parentDir: string, repoName: string, packageFolders: readonly string[]): Promise<string> {
  const repoDir = path.join(parentDir, repoName);
  for (const packageFolder of packageFolders) writeLibAndApp(path.join(repoDir, packageFolder));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'map me'], { cwd: repoDir });
  return repoDir;
}

function areaSpanOf(board: Board, areaTitle: string): { left: number; right: number; boxIds: string[] } {
  const areaFrame = [...board.elements.values()].find((element) => element.kind === 'frame' && element.title === areaTitle);
  assert.ok(areaFrame?.kind === 'frame', `the board has an area frame titled ${areaTitle}`);
  const lefts = areaFrame.contains.flatMap((boxId) => {
    const box = board.elements.get(boxId);
    return box?.kind === 'box' && typeof box.place === 'object' && 'at' in box.place ? [box.place.at.x] : [];
  });
  return { left: Math.min(...lefts), right: Math.max(...lefts) + BOX_WIDTH, boxIds: areaFrame.contains };
}

test('repos and folders of one repo with the same folder names draw their own boxes side by side on one map board, a redraw of one leaves the others alone, and a removed or vanished area leaves and the rest close up', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-areas-'));
  const firstRepoDir = await createRepo(tmpDir, 'first', ['.']);
  const secondRepoDir = await createRepo(tmpDir, 'second', ['.']);
  const wiring = openWhiteboardWiring({ boardsRoot: path.join(tmpDir, 'boards') });
  const areas = createStudioReposStore({ filePath: path.join(tmpDir, 'studio-repos.json'), logger: console });
  const codemap = createCodemapService({ whiteboards: wiring, areas, specsRoot: path.join(tmpDir, 'specs') });
  const reader = { id: 'areas-reader', name: 'reader', project: firstRepoDir };
  const readBoard = async (): Promise<Board> => {
    const read = await wiring.readPlanBoard(reader, 'Code map');
    assert.ok(read.ok);
    return read.board;
  };
  const libBoxIdsOf = (board: Board) => [...board.elements.values()].filter((element) => element.kind === 'box' && element.title === 'lib').map((element) => element.id);

  assert.equal((await codemap.handle({ repoDir: firstRepoDir }, { sub: 'map' })).ok, true);
  assert.equal((await codemap.handle({ repoDir: secondRepoDir }, { sub: 'map' })).ok, true);
  assert.equal(await codemap.mapBoardIdOfRepo(firstRepoDir), await codemap.mapBoardIdOfRepo(secondRepoDir), 'both repos draw on the one map board');

  const drawn = await readBoard();
  assert.equal(libBoxIdsOf(drawn).length, 2, 'each repo draws its own lib box');
  const firstSpan = areaSpanOf(drawn, 'first');
  const secondSpan = areaSpanOf(drawn, 'second');
  assert.ok(firstSpan.right < secondSpan.left, `the second area starts right of the first (first ends ${firstSpan.right}, second starts ${secondSpan.left})`);
  assert.deepEqual(firstSpan.boxIds.filter((boxId) => secondSpan.boxIds.includes(boxId)), [], 'no box belongs to both areas');

  fs.mkdirSync(path.join(firstRepoDir, 'tools'));
  fs.writeFileSync(path.join(firstRepoDir, 'tools', 'build.ts'), "import { part0 } from '../lib/part0.ts';\nexport const built = part0;");
  fs.rmSync(path.join(firstRepoDir, 'app'), { recursive: true });
  await execFileAsync('git', ['add', '-A'], { cwd: firstRepoDir });
  await execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'swap app for tools'], { cwd: firstRepoDir });
  assert.equal((await codemap.handle({ repoDir: firstRepoDir }, { sub: 'map' })).ok, true);
  const redrawn = await readBoard();
  const appTitles = [...redrawn.elements.values()].filter((element) => element.kind === 'box' && element.title === 'app');
  assert.equal(appTitles.length, 1, 'the first repo swept its own app box and left the second repo its app box');
  assert.deepEqual(areaSpanOf(redrawn, 'second').boxIds.sort(), secondSpan.boxIds.sort(), 'a redraw of the first repo keeps every box of the second');

  assert.deepEqual(await codemap.removeArea(firstRepoDir), { ok: true });
  assert.deepEqual((await areas.repos()).map((listed) => listed.repoDir), [secondRepoDir], 'removing an area takes its repo off the stored list in the same step');
  for (let attempt = 0; attempt < 200 && areaSpanOf(await readBoard(), 'second').left !== firstSpan.left; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  const afterRemoval = await readBoard();
  assert.equal([...afterRemoval.elements.values()].some((element) => element.kind === 'frame' && element.title === 'first'), false, 'the removed area has left the board');
  assert.equal(libBoxIdsOf(afterRemoval).length, 1);
  assert.equal(areaSpanOf(afterRemoval, 'second').left, firstSpan.left, 'the remaining area closes up to the start of the row');

  const packagesRepoDir = await createRepo(tmpDir, 'packages', ['web', 'api']);
  assert.equal((await codemap.handle({ repoDir: path.join(packagesRepoDir, 'web') }, { sub: 'map' })).ok, true);
  assert.equal((await codemap.handle({ repoDir: path.join(packagesRepoDir, 'api') }, { sub: 'map' })).ok, true);
  const withPackages = await readBoard();
  assert.equal(libBoxIdsOf(withPackages).length, 3, 'two folders of one git repo each keep their own lib box beside the second repo');
  assert.ok(areaSpanOf(withPackages, 'web').right < areaSpanOf(withPackages, 'api').left);

  fs.renameSync(secondRepoDir, path.join(tmpDir, 'second-moved'));
  assert.equal((await codemap.handle({ repoDir: path.join(tmpDir, 'second-moved') }, { sub: 'map' })).ok, true);
  const hasSecondArea = async () => [...(await readBoard()).elements.values()].some((element) => element.kind === 'frame' && element.title === 'second');
  for (let attempt = 0; attempt < 200 && await hasSecondArea(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await hasSecondArea(), false, 'the area of a folder that is gone leaves when the next repo joins');
  assert.equal((await areas.repos()).some((listed) => listed.repoDir === secondRepoDir), false);
});

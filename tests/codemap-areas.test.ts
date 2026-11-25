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

  const otherWebDir = await createRepo(path.join(tmpDir, 'other'), 'web', ['.']);
  assert.equal((await codemap.handle({ repoDir: otherWebDir }, { sub: 'map' })).ok, true);
  assert.equal((await areas.repos()).find((listed) => listed.repoDir === otherWebDir)?.repoName, 'web-2', 'a second repo with a taken folder name gets a name of its own');
  const namedBoxes = (await codemap.boxesOfStudioPaths('areas-reader', ['web-2/lib/part0.ts', path.join(otherWebDir, 'lib', 'part0.ts'), 'web/lib/part0.ts'])).boxIdByPath;
  assert.equal(namedBoxes['web-2/lib/part0.ts'], namedBoxes[path.join(otherWebDir, 'lib', 'part0.ts')], 'a repo name and an absolute path reach the same box');
  assert.notEqual(namedBoxes['web-2/lib/part0.ts'], namedBoxes['web/lib/part0.ts'], 'each repo name reaches its own area');

  const emptyRepoDir = path.join(tmpDir, 'empty');
  fs.mkdirSync(emptyRepoDir);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: emptyRepoDir });
  codemap.openArea(emptyRepoDir);
  const emptyAreaOf = async () => (await codemap.studioAreas()).areas.find((area) => area.repoDir === emptyRepoDir);
  for (let attempt = 0; attempt < 200 && !(await emptyAreaOf()); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  const emptyArea = await emptyAreaOf();
  assert.match(emptyArea?.mapError ?? '', /no commit to map/, 'a repo opened in Studio whose map cannot be built is listed with the reason');
  assert.equal(emptyArea?.isMapFailed, true);

  fs.renameSync(secondRepoDir, path.join(tmpDir, 'second-moved'));
  assert.equal((await codemap.handle({ repoDir: path.join(tmpDir, 'second-moved') }, { sub: 'map' })).ok, true);
  const hasSecondArea = async () => [...(await readBoard()).elements.values()].some((element) => element.kind === 'frame' && element.title === 'second');
  for (let attempt = 0; attempt < 200 && await hasSecondArea(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await hasSecondArea(), false, 'the area of a folder that is gone leaves when the next repo joins');
  assert.equal((await areas.repos()).some((listed) => listed.repoDir === secondRepoDir), false);
});

test('a repo with no branch agent folds to one card that keeps its place in the row, and opens when a branch starts there or the operator opens it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-folds-'));
  const firstRepoDir = await createRepo(tmpDir, 'first', ['.']);
  const secondRepoDir = await createRepo(tmpDir, 'second', ['.']);
  const wiring = openWhiteboardWiring({ boardsRoot: path.join(tmpDir, 'boards') });
  const busyRepoDirs = new Set<string>();
  const codemap = createCodemapService({ whiteboards: wiring, specsRoot: path.join(tmpDir, 'specs'), isAreaIdle: (repoDir) => !busyRepoDirs.has(repoDir) });
  const reader = { id: 'folds-reader', name: 'reader', project: firstRepoDir };
  const areaFrameOf = async (areaTitle: string) => {
    const read = await wiring.readPlanBoard(reader, 'Code map');
    assert.ok(read.ok);
    const areaFrame = [...read.board.elements.values()].find((element) => element.kind === 'frame' && element.title === areaTitle);
    assert.ok(areaFrame?.kind === 'frame');
    const firstBox = read.board.elements.get(areaFrame.contains[0] ?? '');
    const collapsedFolderCount = [...read.board.elements.values()].filter((element) => element.kind === 'frame' && element.collapsed && element.id !== areaFrame.id && element.contains.some((boxId) => areaFrame.contains.includes(boxId))).length;
    return { id: areaFrame.id, isFolded: areaFrame.collapsed, cardTitle: firstBox?.kind === 'box' ? firstBox.title : null, left: firstBox?.kind === 'box' && typeof firstBox.place === 'object' && 'at' in firstBox.place ? firstBox.place.at.x : null, collapsedFolderCount };
  };
  const untilFolded = async (areaTitle: string, isFolded: boolean) => {
    for (let attempt = 0; attempt < 300 && (await areaFrameOf(areaTitle)).isFolded !== isFolded; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    return areaFrameOf(areaTitle);
  };

  assert.equal((await codemap.handle({ repoDir: firstRepoDir }, { sub: 'map' })).ok, true);
  assert.equal((await codemap.handle({ repoDir: secondRepoDir }, { sub: 'map' })).ok, true);
  const foldedFirst = await untilFolded('first', true);
  const foldedSecond = await untilFolded('second', true);
  assert.deepEqual([foldedFirst.cardTitle, foldedFirst.collapsedFolderCount], ['first', 0], 'a folded area shows one card named for its repo and holds no folded folder of its own');
  assert.ok(foldedFirst.left !== null && foldedSecond.left !== null && foldedSecond.left - foldedFirst.left < 1000, 'folded areas sit side by side as cards');

  busyRepoDirs.add(firstRepoDir);
  codemap.noteBranchesChanged();
  const openedFirst = await untilFolded('first', false);
  assert.ok(openedFirst.collapsedFolderCount > 0, 'an open area folds its own folders again');
  for (let attempt = 0; attempt < 300 && ((await areaFrameOf('second')).left ?? 0) - (foldedFirst.left ?? 0) < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(((await areaFrameOf('second')).left ?? 0) - (foldedFirst.left ?? 0) >= 1000, 'the area after an opened one moves right to make room');
  assert.equal((await areaFrameOf('second')).isFolded, true);

  assert.deepEqual(await codemap.setFolderOpen(secondRepoDir, foldedSecond.id, true), { ok: true, isOpen: true });
  assert.equal((await untilFolded('second', false)).isFolded, false, 'the operator opens a folded area by its frame');
  assert.deepEqual(await codemap.setFolderOpen(secondRepoDir, foldedSecond.id, false), { ok: true, isOpen: false });
  assert.deepEqual(await codemap.setFolderOpen(firstRepoDir, foldedFirst.id, false), { ok: true, isOpen: true }, 'an area with a branch agent stays open when the board gathers it');
  busyRepoDirs.delete(firstRepoDir);
  codemap.noteBranchesChanged();
  assert.equal((await untilFolded('first', true)).isFolded, true, 'an area folds again when its last branch leaves');
});

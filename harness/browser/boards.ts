import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import type { Layout } from './cases-core.ts';
import { commitFile, findSessionWorktree, pollFor } from './review-changes.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { resolveFfmpegPath } from '../../server/runtime-paths.ts';
import { Board, BoardMediaUploadReply, BoardReview, WHITEBOARD_ASSET_ROUTE, WHITEBOARD_LIMITS, boardMediaDrawnFilename, pointOfBox } from '../../shared/contracts/whiteboard.ts';
import type { Element, Op } from '../../shared/contracts/whiteboard.ts';
import { benchmarkBoard } from '../board-layout-cost.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import { BODY_LINE_HEIGHT, TITLE_BASELINE, TITLE_LINE_HEIGHT } from '../../shared/whiteboard-svg-core.ts';

const UNCOVERED_FILE_NAME = 'board-uncovered.txt';
const WORKTREE_TIMEOUT_MS = 15000;
const REVIEW_TIMEOUT_MS = 20000;
const RESIZE_TIMEOUT_MS = 5000;
const BOARD_TIMEOUT_MS = 5000;
const BOARD_DOC_BOX_ID = 'abstract';
const BOARD_DOC_BOX_TITLE = 'docs/';
const BOARD_DOC_FIRST_DRAFT = '# Abstract\n\n<b>First draft.</b> **Bold**\n\nSee [the spec](https://example.com/spec) here.\n';
const BOARD_DOC_LINK_URL = 'https://example.com/spec';
const LINKED_DOC_BOX_ID = 'linked-doc';
const LINKED_DOC_PATH = 'docs/linked-card.md';

interface OpenBoard {
  page: Page;
  panel: Locator;
  boardId: string;
}

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type BoardElement = Element;

const BoardReply = z.object({ board: Board });
const ReviewReply = z.object({ review: BoardReview });
const CreatedReply = z.object({ summary: z.object({ id: z.string() }) });
const AddedSessionReply = z.object({ sessionId: z.string() });
const CAMERA_TRANSFORM_PATTERN = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/;

function titled(title: string): (element: BoardElement) => boolean {
  return (element) => 'title' in element && element.title === title;
}

async function boardOf(open: OpenBoard): Promise<Board> {
  return BoardReply.parse(await controlReplyOf(open.page, 'whiteboard-get', { boardId: open.boardId })).board;
}

async function reviewOf(open: OpenBoard): Promise<BoardReview> {
  return ReviewReply.parse(await controlReplyOf(open.page, 'whiteboard-review', { boardId: open.boardId })).review;
}

async function shownBoardOf(open: OpenBoard): Promise<Board> {
  const board = await boardOf(open);
  await open.panel.locator(`.wb-board-meta[data-board-version="${board.version}"]`).waitFor();
  return board;
}

async function elementWhere(open: OpenBoard, label: string, isMatch: (element: BoardElement) => boolean): Promise<BoardElement> {
  const found = await pollFor(label, BOARD_TIMEOUT_MS, async () => [...(await boardOf(open)).elements.values()].find(isMatch) ?? null);
  await shownBoardOf(open);
  return found;
}

async function boardWithout(open: OpenBoard, label: string, isMatch: (element: BoardElement) => boolean): Promise<void> {
  await pollFor(label, BOARD_TIMEOUT_MS, async () => ([...(await boardOf(open)).elements.values()].some(isMatch) ? null : true));
  await shownBoardOf(open);
}

async function laidOutOf(open: OpenBoard, elementId: string) {
  const laidOut = layoutBoard(await shownBoardOf(open)).elements.find((element) => element.id === elementId);
  assert.ok(laidOut, `the board lays out ${elementId}`);
  return laidOut;
}

async function wirePathOf(open: OpenBoard, wireId: string): Promise<string> {
  const laidOut = await laidOutOf(open, wireId);
  assert.ok(laidOut.kind === 'wire');
  return laidOut.path;
}

async function screenRectOf(open: OpenBoard, elementId: string): Promise<ScreenRect> {
  const laidOut = await laidOutOf(open, elementId);
  assert.ok(laidOut.kind !== 'wire', `${elementId} is drawn as a rect`);
  return screenRectOn(await cameraOf(open), laidOut);
}

interface Camera {
  left: number;
  top: number;
  translateX: number;
  translateY: number;
  scale: number;
}

function screenRectOn(camera: Camera, rect: ScreenRect): ScreenRect {
  return { x: camera.left + camera.translateX + rect.x * camera.scale, y: camera.top + camera.translateY + rect.y * camera.scale, width: rect.width * camera.scale, height: rect.height * camera.scale };
}

async function cameraOf(open: OpenBoard): Promise<Camera> {
  const placement = await open.panel.locator('.wb-viewport').evaluate((viewport) => {
    const viewportRect = viewport.getBoundingClientRect();
    const world = viewport.querySelector('.wb-world');
    return { left: viewportRect.left + viewport.clientLeft, top: viewportRect.top + viewport.clientTop, transform: world instanceof HTMLElement ? world.style.transform : '' };
  });
  const camera = CAMERA_TRANSFORM_PATTERN.exec(placement.transform);
  assert.ok(camera, `the board camera is readable from ${placement.transform}`);
  return { left: placement.left, top: placement.top, translateX: Number(camera[1]), translateY: Number(camera[2]), scale: Number(camera[3]) };
}

function centerOf(rect: ScreenRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function clickElement(open: OpenBoard, elementId: string): Promise<void> {
  const center = centerOf(await screenRectOf(open, elementId));
  await open.page.mouse.click(center.x, center.y);
}

async function cursorAt(open: OpenBoard, point: { x: number; y: number }): Promise<string> {
  await open.page.mouse.move(point.x, point.y);
  return open.panel.locator('.wb-viewport').evaluate((viewport) => (viewport instanceof HTMLElement ? viewport.style.cursor : ''));
}

async function isMoreOpenIn(inspect: Locator): Promise<boolean> {
  return inspect.locator('details[data-disclosure="more"]').evaluate((details) => details instanceof HTMLDetailsElement && details.open);
}

async function openMoreIn(inspect: Locator): Promise<void> {
  if (await isMoreOpenIn(inspect)) return;
  await inspect.locator('details[data-disclosure="more"] > summary').click();
}

async function waitForPressedShape(inspect: Locator, shape: string): Promise<void> {
  await inspect.locator(`[data-field="shape-${shape}"][aria-pressed="true"]`).waitFor();
}

function drawingTools(panel: Locator): Locator {
  return panel.getByRole('group', { name: 'Drawing tools', exact: true });
}

function drawingTool(panel: Locator, name: string): Locator {
  return drawingTools(panel).getByRole('button', { name, exact: true });
}

async function addPlanStep(open: OpenBoard, offset: { x: number; y: number }, title: string): Promise<BoardElement> {
  await drawingTool(open.panel, 'Box').click();
  const box = await placeBoxWithTool(open, offset, title);
  await open.panel.locator('.wb-inspect').getByRole('combobox', { name: 'Step', exact: true }).selectOption('planned');
  return elementWhere(open, `${title} as a planned step`, (element) => element.id === box.id && element.kind === 'box' && element.step?.status === 'planned');
}

async function placeBoxWithTool(open: OpenBoard, offset: { x: number; y: number }, title: string): Promise<BoardElement> {
  const canvasBox = await open.panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  await open.page.mouse.click(canvasBox.x + offset.x, canvasBox.y + offset.y);
  const titleInput = open.page.getByRole('textbox', { name: 'Box title', exact: true });
  await titleInput.fill(title);
  await open.page.keyboard.press('Enter');
  return elementWhere(open, `a box titled ${title}`, titled(title));
}

async function verifyResizedBoxes(open: OpenBoard, boxIds: readonly [string, ...string[]]): Promise<void> {
  const widthsOf = () => Promise.all(boxIds.map(async (boxId) => {
    const laidOut = await laidOutOf(open, boxId);
    return laidOut.kind === 'wire' ? 0 : laidOut.width;
  }));
  const widthsBefore = await widthsOf();
  const heightOfFirst = async () => {
    const laidOut = await laidOutOf(open, boxIds[0]);
    return laidOut.kind === 'wire' ? 0 : laidOut.height;
  };
  const heightBefore = await heightOfFirst();
  const rect = await screenRectOf(open, boxIds[0]);
  await open.page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const handle = { x: rect.x + rect.width - 4, y: rect.y + rect.height - 4 };
  assert.equal(await cursorAt(open, handle), 'nwse-resize', 'the bottom right corner of a hovered box is its resize handle');
  await open.page.mouse.down();
  await open.page.mouse.move(handle.x + 120, handle.y + 80, { steps: 6 });
  await open.page.mouse.up();
  const widenings = await pollFor('dragging the corner handle widens every selected box', RESIZE_TIMEOUT_MS, async () => {
    const widthsAfter = await widthsOf();
    return widthsAfter.every((width, index) => width > (widthsBefore[index] ?? width)) ? widthsAfter.map((width, index) => width - (widthsBefore[index] ?? width)) : null;
  });
  assert.ok(widenings.every((widening) => widening === widenings[0]), `every selected box widens by the same amount, got ${widenings.join(', ')}`);
  assert.ok(await heightOfFirst() > heightBefore, 'dragging the corner handle down makes the box taller');
  await open.panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await pollFor('one undo puts every box back to its width', RESIZE_TIMEOUT_MS, async () => ((await widthsOf()).every((width, index) => width === widthsBefore[index]) ? true : null));
}

async function selectBoxes(open: OpenBoard, boxIds: readonly string[]): Promise<void> {
  for (const [index, boxId] of boxIds.entries()) {
    const center = centerOf(await screenRectOf(open, boxId));
    if (index > 0) await open.page.keyboard.down('Shift');
    await open.page.mouse.click(center.x, center.y);
    if (index > 0) await open.page.keyboard.up('Shift');
  }
}

const DROP_OFFSET = { x: -40, y: 300 };

async function verifyBoxStaysWhereDropped(open: OpenBoard, boxId: string, boxName: string): Promise<void> {
  const startRect = await screenRectOf(open, boxId);
  const versionBeforeDrop = (await boardOf(open)).version;
  const start = centerOf(startRect);
  await open.page.mouse.move(start.x, start.y);
  await open.page.mouse.down();
  await open.page.mouse.move(start.x + DROP_OFFSET.x, start.y + DROP_OFFSET.y, { steps: 8 });
  await open.page.mouse.up();
  await pollFor(`dropping ${boxName} saves its place`, BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeDrop ? true : null));
  const restingRect = await screenRectOf(open, boxId);
  assert.ok(Math.abs(restingRect.x - startRect.x - DROP_OFFSET.x) < 2 && Math.abs(restingRect.y - startRect.y - DROP_OFFSET.y) < 2, `${boxName} stays where it was dropped, landed ${restingRect.x - startRect.x}, ${restingRect.y - startRect.y} from where it sat`);
}

async function verifyStacking(open: OpenBoard, anchorBoxId: string): Promise<void> {
  const { page, boardId } = open;
  const anchor = (await boardOf(open)).elements.get(anchorBoxId);
  const origin = anchor?.kind === 'box' ? pointOfBox(anchor) : null;
  assert.ok(origin, 'the anchor box has a point');
  const fromId = 'stack-from';
  const cardId = 'stack-card';
  const droppedId = 'stack-dropped';
  const wireId = 'stack-wire';
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [
    { op: 'add', element: { kind: 'box', id: fromId, title: 'Stack source', place: { at: { x: origin.x, y: origin.y + 100 } } } },
    { op: 'add', element: { kind: 'box', id: cardId, title: 'Stack card', place: { at: { x: origin.x, y: origin.y + 200 } } } },
    { op: 'add', element: { kind: 'box', id: droppedId, title: 'Stack dropped', place: { at: { x: origin.x + 240, y: origin.y + 200 } } } },
    { op: 'add', element: { kind: 'wire', id: wireId, from: fromId, to: droppedId } },
  ] });
  await laidOutOf(open, droppedId);
  const dropped = centerOf(await screenRectOf(open, droppedId));
  const card = centerOf(await screenRectOf(open, cardId));
  await page.mouse.move(dropped.x, dropped.y);
  await page.mouse.down();
  await page.mouse.move(card.x, card.y, { steps: 8 });
  await page.mouse.up();
  const isStackOfBoth = (element: BoardElement) => element.kind === 'frame' && element.collapsed && element.contains[0] === cardId && element.contains[1] === droppedId;
  const stack = await elementWhere(open, 'dropping a box on another box stacks them', isStackOfBoth);
  const stackLayout = layoutBoard(await boardOf(open));
  assert.equal(stackLayout.elements.some((element) => element.id === droppedId), false, 'the dropped box hides under the stack card');
  const laidOutWire = stackLayout.elements.find((element) => element.id === wireId);
  const laidOutCard = stackLayout.elements.find((element) => element.id === cardId);
  assert.ok(laidOutWire?.kind === 'wire' && laidOutCard && laidOutCard.kind !== 'wire', 'the wire and the stack card stay laid out');
  const isEndOnCard = Math.abs(laidOutWire.end.x - (laidOutCard.x + laidOutCard.width / 2)) <= laidOutCard.width / 2 + 2 && Math.abs(laidOutWire.end.y - (laidOutCard.y + laidOutCard.height / 2)) <= laidOutCard.height / 2 + 2;
  assert.ok(isEndOnCard, 'a wire to the hidden box ends at the stack card');
  const cardCenter = centerOf(await screenRectOf(open, cardId));
  await page.mouse.click(cardCenter.x, cardCenter.y);
  await elementWhere(open, 'clicking the stack card fans it out', (element) => element.id === stack.id && element.kind === 'frame' && !element.collapsed);
  await laidOutOf(open, droppedId);
  await page.keyboard.press('Escape');
  await elementWhere(open, 'clearing the selection gathers the clicked stack again', (element) => element.id === stack.id && element.kind === 'frame' && element.collapsed);
  await page.mouse.click(cardCenter.x, cardCenter.y);
  await elementWhere(open, 'a click fans the stack out before the board scrolls away', (element) => element.id === stack.id && element.kind === 'frame' && !element.collapsed);
  for (let scrollStep = 0; scrollStep < 6; scrollStep += 1) await page.mouse.wheel(3000, 0);
  await page.keyboard.press('Escape');
  for (let scrollStep = 0; scrollStep < 6; scrollStep += 1) await page.mouse.wheel(-3000, 0);
  await elementWhere(open, 'a stack left while scrolled out of view gathers once it is back', (element) => element.id === stack.id && element.kind === 'frame' && element.collapsed);
  await page.mouse.click(cardCenter.x, cardCenter.y);
  await elementWhere(open, 'a second click fans the stack out again', (element) => element.id === stack.id && element.kind === 'frame' && !element.collapsed);
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'set', id: stack.id, fields: { collapsed: true } }] });
  await elementWhere(open, 'an agent gathers the clicked stack', (element) => element.id === stack.id && element.kind === 'frame' && element.collapsed);
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'set', id: stack.id, fields: { collapsed: false } }] });
  await elementWhere(open, 'an agent opens the stack', (element) => element.id === stack.id && element.kind === 'frame' && !element.collapsed);
  await page.keyboard.press('Escape');
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'set', id: stack.id, fields: { title: 'agent opened' } }] });
  await elementWhere(open, 'a stack an agent opened stays open when the selection clears', (element) => element.id === stack.id && element.kind === 'frame' && element.title === 'agent opened' && !element.collapsed);
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [stack.id, wireId, fromId, cardId, droppedId].map((id) => ({ op: 'remove', id })) });
  await boardWithout(open, 'the stack check cleans up', (element) => element.id === cardId);
}

async function verifyNoteShapes(open: OpenBoard): Promise<void> {
  const { page, panel, boardId } = open;
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('s');
  const placedNote = await placeBoxWithTool(open, { x: 40, y: 300 }, 'Ask the team');
  await panel.locator('.wb-inspect').getByRole('group', { name: 'Tone', exact: true }).getByRole('button', { name: 'Green', exact: true }).click();
  await elementWhere(open, 'the note tool places a note that takes the picked tone', (element) => element.id === placedNote.id && element.kind === 'box' && element.shape === 'note' && element.tone === 'green');
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  const looseWords = await placeBoxWithTool(open, { x: 40, y: 420 }, 'Loose words');
  assert.ok(looseWords.kind === 'box' && looseWords.shape === 'box' && looseWords.borderless === true, 'the text tool places a borderless box');
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('b');
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 520);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(canvasBox.x + 40 + step * 20, canvasBox.y + 520 + step * 5);
  await page.mouse.up();
  const ink = await elementWhere(open, 'the pen draws a stroke', (element) => element.kind === 'stroke');
  assert.ok(ink.kind === 'stroke' && ink.points.length >= 8, 'a drawn stroke keeps the points it passed through');
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
  await clickElement(open, ink.id);
  await page.keyboard.press('Delete');
  await boardWithout(open, 'a selected stroke erases with Delete', (element) => element.id === ink.id);
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [placedNote.id, looseWords.id].map((id) => ({ op: 'remove', id })) });
  await boardWithout(open, 'the note and text check cleans up', (element) => element.id === placedNote.id);
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
}

function lineTextsOf(element: BoardElement): string[] {
  return element.kind === 'box' ? element.lines.map((line) => line.text) : [];
}

async function lineCenterOf(open: OpenBoard, boxId: string, lineIndex: number): Promise<{ x: number; y: number }> {
  const laidOut = await laidOutOf(open, boxId);
  assert.ok(laidOut.kind === 'box', `${boxId} is a box`);
  const firstRowIndexes = laidOut.bodyLines.flatMap((line, rowIndex) => (line.isFirstRow ? [rowIndex] : []));
  const rowIndex = firstRowIndexes[lineIndex];
  assert.ok(rowIndex !== undefined, `${boxId} draws line ${lineIndex}`);
  const baseline = laidOut.y + TITLE_BASELINE + (laidOut.wasLines.length + laidOut.titleLines.length) * TITLE_LINE_HEIGHT + rowIndex * BODY_LINE_HEIGHT;
  const camera = await cameraOf(open);
  return { x: camera.left + camera.translateX + (laidOut.x + 40) * camera.scale, y: camera.top + camera.translateY + (baseline - 4) * camera.scale };
}

async function verifyLineEditing(open: OpenBoard): Promise<void> {
  const { page, panel, boardId } = open;
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('r');
  const card = await placeBoxWithTool(open, { x: 40, y: 300 }, 'Line card');
  const cardRect = await screenRectOf(open, card.id);
  await page.mouse.dblclick(cardRect.x + 40, cardRect.y + cardRect.height - 5);
  const lineInput = page.getByRole('textbox', { name: 'Box line', exact: true });
  await lineInput.fill('first');
  await page.keyboard.press('Enter');
  await lineInput.fill('second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await elementWhere(open, 'double-clicking the empty body and pressing Enter adds lines', (element) => element.id === card.id && lineTextsOf(element).join('|') === 'first|second');
  assert.equal(await lineInput.count(), 0, 'Enter on an empty new line closes the line editor');
  const firstLine = await lineCenterOf(open, card.id, 0);
  await page.mouse.dblclick(firstLine.x, firstLine.y);
  assert.equal(await lineInput.inputValue(), 'first', 'double-clicking a line edits that line');
  await lineInput.fill('discarded');
  await page.keyboard.press('Escape');
  assert.equal(await lineInput.count(), 0, 'Escape closes the line editor');
  await page.mouse.dblclick(firstLine.x, firstLine.y);
  const styleButton = page.getByRole('button', { name: 'Line style', exact: true });
  await styleButton.click();
  await page.getByRole('menuitemradio', { name: 'Code', exact: true }).click();
  await styleButton.click();
  await page.getByRole('menuitemcheckbox', { name: 'Muted', exact: true }).click();
  assert.equal(await lineInput.inputValue(), 'first', 'the style menu keeps the line editor open');
  await lineInput.fill('first code');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const styled = await elementWhere(open, 'the style menu sets the line style and muted', (element) => element.id === card.id && lineTextsOf(element).join('|') === 'first code|second');
  assert.ok(styled.kind === 'box' && styled.lines[0]?.style === 'code' && styled.lines[0].muted, 'the first line is muted code');
  const secondLine = await lineCenterOf(open, card.id, 1);
  await page.mouse.dblclick(secondLine.x, secondLine.y);
  await lineInput.fill('');
  await page.keyboard.press('Backspace');
  assert.equal(await lineInput.inputValue(), 'first code', 'Backspace on an empty line edits the line above');
  await page.keyboard.press('Escape');
  await elementWhere(open, 'Backspace on an empty line removes it', (element) => element.id === card.id && lineTextsOf(element).join('|') === 'first code');
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'remove', id: card.id }] });
  await boardWithout(open, 'the line editing check cleans up', (element) => element.id === card.id);
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
}

const BOARD_SPLIT_KEY = process.platform === 'darwin' ? 'Meta+KeyB' : 'Alt+KeyB';
const LINE_END_KEY = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

async function verifyBoardDoc(open: OpenBoard): Promise<void> {
  const { page, panel, boardId } = open;
  const uploadReply: unknown = await page.evaluate(async ({ assetRoute, docText }) => {
    const response = await fetch(assetRoute, { method: 'POST', body: docText, headers: { 'content-type': 'text/markdown', 'x-glimmervoid-upload-name': 'abstract.md' } });
    const reply: unknown = await response.json();
    return reply;
  }, { assetRoute: WHITEBOARD_ASSET_ROUTE, docText: BOARD_DOC_FIRST_DRAFT });
  const firstDraftMedia = BoardMediaUploadReply.parse(uploadReply).media;
  assert.equal(firstDraftMedia.kind, 'doc', 'the board keeps a Markdown upload as a document');
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'add', element: { kind: 'box', id: BOARD_DOC_BOX_ID, title: BOARD_DOC_BOX_TITLE, place: { at: { x: 40, y: 160 } }, media: firstDraftMedia } }] });
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
  const docCard = panel.locator('.wb-media[data-media-kind="doc"] .wb-media-doc');
  await docCard.locator('.plan-heading', { hasText: 'Abstract' }).waitFor();
  assert.equal(await docCard.locator('b').count(), 0, 'a document box draws Markdown as text, never as markup');
  await clickElement(open, BOARD_DOC_BOX_ID);
  const editor = page.locator('.doc-editor');
  const paper = editor.locator('.doc-markup-paper');
  await paper.locator('.doc-markup-text', { hasText: 'First draft.' }).waitFor();
  assert.deepEqual((await editor.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent))).sort(), ['Close', 'Redo', 'Undo'], 'a document opens on the red pen paper with only its Close, Undo and Redo buttons');
  await paper.locator('.doc-markup-line[data-block="h1"] .doc-markup-text[data-inline="syntax"]', { hasText: '#' }).waitFor();
  await paper.locator('.doc-markup-text[data-inline="strong"]', { hasText: /^Bold$/ }).waitFor();
  const linkLabel = paper.locator('.doc-markup-text[data-inline="link"]', { hasText: /^the spec$/ });
  const linkTarget = paper.locator('.doc-markup-text[data-inline="link-syntax"]', { hasText: `](${BOARD_DOC_LINK_URL})` });
  await linkLabel.waitFor();
  assert.equal(await linkTarget.isVisible(), false, 'a valid Markdown link shows only its label');
  await page.evaluate(() => {
    const openedUrls: string[] = [];
    Reflect.set(window, 'openedUrls', openedUrls);
    window.open = (url) => {
      openedUrls.push(String(url));
      return null;
    };
  });
  await linkLabel.click({ modifiers: ['ControlOrMeta'] });
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'openedUrls')), [BOARD_DOC_LINK_URL], 'a modifier click on a link label opens its URL');
  await linkLabel.click();
  await linkTarget.waitFor({ state: 'visible' });
  await paper.locator('.doc-markup-text', { hasText: 'First draft.' }).click();
  await linkTarget.waitFor({ state: 'hidden' });
  const copiedText = await paper.evaluate((paperElement) => {
    const linkLine = paperElement.querySelector('[data-inline="link"]')?.closest('.doc-markup-line');
    const lineRange = document.createRange();
    if (linkLine) lineRange.selectNodeContents(linkLine);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(lineRange);
    const copyEvent = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    paperElement.dispatchEvent(copyEvent);
    return copyEvent.clipboardData?.getData('text/plain') ?? '';
  });
  assert.ok(copiedText.includes(`[the spec](${BOARD_DOC_LINK_URL})`), `copying a line keeps its link source, got ${JSON.stringify(copiedText)}`);
  await page.keyboard.press(LINE_END_KEY);
  await page.keyboard.type(' Again.');
  await paper.locator('.doc-markup-insertion').waitFor();
  assert.equal(await paper.locator('.doc-markup-line > .doc-markup-insertion:last-child').count(), 1, 'typing at the end of a styled line marks the end of its source');
  await editor.locator('.doc-editor-status-text', { hasText: /^Saved$/ }).waitFor();
  await docCard.locator('.plan-paragraph', { hasText: 'Again.' }).waitFor();
  await page.keyboard.type(' Twice.');
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'detached' });
  await docCard.locator('.plan-paragraph', { hasText: 'Twice.' }).waitFor();
  const savedBox = (await boardOf(open)).elements.get(BOARD_DOC_BOX_ID);
  assert.ok(savedBox?.kind === 'box' && savedBox.media?.kind === 'doc' && savedBox.media.asset !== firstDraftMedia.asset, 'a saved document is stored on the board as a new asset');
  for (const undoneText of ['Twice.', 'Again.']) {
    await panel.getByRole('button', { name: 'Undo', exact: true }).click();
    await docCard.locator('.plan-paragraph', { hasText: undoneText }).waitFor({ state: 'detached' });
  }
  await docCard.locator('.plan-paragraph', { hasText: 'First draft.' }).waitFor();
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'remove', id: BOARD_DOC_BOX_ID }] });
  await panel.locator('.wb-media[data-media-kind="doc"]').waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
}

async function uploadBoardDoc(page: Page, docText: string, uploadName: string) {
  const uploadReply: unknown = await page.evaluate(async ({ assetRoute, text, name }) => {
    const response = await fetch(assetRoute, { method: 'POST', body: text, headers: { 'content-type': 'text/markdown', 'x-glimmervoid-upload-name': name } });
    const reply: unknown = await response.json();
    return reply;
  }, { assetRoute: WHITEBOARD_ASSET_ROUTE, text: docText, name: uploadName });
  return BoardMediaUploadReply.parse(uploadReply).media;
}

async function selectBoxByTitle(open: OpenBoard, boxId: string): Promise<void> {
  const boxRect = await screenRectOf(open, boxId);
  await open.page.mouse.click(boxRect.x + boxRect.width / 2, boxRect.y + 8);
}

async function verifyLinkedBoardDoc(open: OpenBoard, worktreePath: string): Promise<void> {
  const { page, panel, boardId } = open;
  const linkedFilePath = path.join(worktreePath, LINKED_DOC_PATH);
  const linkedFileText = () => fs.promises.readFile(linkedFilePath, 'utf8');
  fs.mkdirSync(path.dirname(linkedFilePath), { recursive: true });
  fs.writeFileSync(linkedFilePath, '# Linked\n\nFrom the repo.\n');
  const boardCopyMedia = await uploadBoardDoc(page, '# Board copy\n', 'linked-card.md');
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'add', element: { kind: 'box', id: LINKED_DOC_BOX_ID, title: 'Linked card', place: { at: { x: 40, y: 700 } }, media: boardCopyMedia } }] });
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
  const linkedCard = panel.locator(`.wb-media[data-box-id="${LINKED_DOC_BOX_ID}"]`);
  await linkedCard.locator('.plan-heading', { hasText: 'Board copy' }).waitFor();
  await selectBoxByTitle(open, LINKED_DOC_BOX_ID);
  const inspect = panel.locator('.wb-inspect');
  await openMoreIn(inspect);
  const linkStatus = inspect.locator('.wb-inspect-link-status');
  await linkStatus.filter({ hasText: 'Not linked' }).waitFor();
  assert.equal(await inspect.getByRole('button', { name: 'Unlink this card from its file', exact: true }).isDisabled(), true, 'Unlink is off for a card with no link');
  await inspect.getByRole('textbox', { name: 'Linked file path, relative to the code session worktree', exact: true }).fill(LINKED_DOC_PATH);
  await inspect.getByRole('button', { name: 'Link this card to the file', exact: true }).click();
  await linkedCard.locator('.plan-heading', { hasText: /^Linked$/ }).waitFor({ timeout: REVIEW_TIMEOUT_MS });
  await linkStatus.filter({ hasText: 'In sync with the file' }).waitFor({ timeout: REVIEW_TIMEOUT_MS });
  assert.equal(await linkedCard.locator('.wb-media-link-chip').count(), 0, 'a card in sync with its file carries no chip');
  await clickElement(open, LINKED_DOC_BOX_ID);
  const editor = page.locator('.doc-editor');
  const paper = editor.locator('.doc-markup-paper');
  await paper.locator('.doc-markup-text', { hasText: 'From the repo.' }).click();
  await page.keyboard.press(LINE_END_KEY);
  await page.keyboard.type(' Saved here.');
  await editor.locator('.doc-editor-status-text', { hasText: /^Saved$/ }).waitFor();
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'detached' });
  await pollFor('the editor save reaches the linked file', BOARD_TIMEOUT_MS, async () => ((await linkedFileText()).includes('Saved here.') ? true : null));
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await linkedCard.locator('.wb-media-link-chip[data-link-state="card-ahead"]', { hasText: 'Not saved to file' }).waitFor({ timeout: REVIEW_TIMEOUT_MS });
  assert.ok((await linkedFileText()).includes('Saved here.'), 'undo changes the card, never the file');
  fs.rmSync(linkedFilePath);
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'set', id: LINKED_DOC_BOX_ID, fields: { title: 'Linked card, file gone' } }] });
  const brokenChip = linkedCard.locator('.wb-media-link-chip[data-link-state="broken"]', { hasText: 'File missing' });
  await brokenChip.waitFor({ timeout: REVIEW_TIMEOUT_MS });
  await linkedCard.locator('.plan-heading', { hasText: /^Linked$/ }).waitFor();
  await clickElement(open, LINKED_DOC_BOX_ID);
  await paper.locator('.doc-markup-text', { hasText: 'From the repo.' }).click();
  await page.keyboard.type(' Lost.');
  await editor.locator('.doc-editor-status-text', { hasText: 'read-only' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(fs.existsSync(linkedFilePath), false, 'a broken link never writes the file');
  await selectBoxByTitle(open, LINKED_DOC_BOX_ID);
  await inspect.getByRole('button', { name: 'Unlink this card from its file', exact: true }).click();
  await brokenChip.waitFor({ state: 'detached' });
  await linkStatus.filter({ hasText: 'Not linked' }).waitFor();
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'remove', id: LINKED_DOC_BOX_ID }] });
  await linkedCard.waitFor({ state: 'detached' });
}

function drawnMediaUrlOf(element: BoardElement): string {
  assert.ok(element.kind === 'box' && element.media, `${element.id} carries media`);
  const drawnFilename = boardMediaDrawnFilename(element.media);
  assert.ok(drawnFilename, `${element.id} has a drawn picture`);
  return `${WHITEBOARD_ASSET_ROUTE}/${drawnFilename}`;
}

async function verifyDroppedPicture(open: OpenBoard): Promise<void> {
  const { page, panel } = open;
  await panel.locator('.wb-canvas').evaluate(async (canvas) => {
    const painted = document.createElement('canvas');
    painted.width = 2400;
    painted.height = 1200;
    const pen = painted.getContext('2d');
    if (pen) pen.fillStyle = '#c084fc';
    pen?.fillRect(0, 0, 2400, 1200);
    const pngBlob = await new Promise<Blob | null>((resolve) => painted.toBlob(resolve, 'image/png'));
    if (!pngBlob) throw new Error('the browser painted no png');
    const transfer = new DataTransfer();
    transfer.items.add(new File([pngBlob], 'dropped-shot.png', { type: 'image/png' }));
    const canvasRect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: canvasRect.left + 60, clientY: canvasRect.top + 300 }));
  });
  const picture = await elementWhere(open, 'the dropped picture box', titled('dropped-shot'));
  await open.panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
  await open.panel.locator('.wb-inspect').waitFor({ state: 'hidden' });
  const drawnUrl = drawnMediaUrlOf(picture);
  assert.match(drawnUrl, /\/[0-9a-f]{64}\.preview\.webp$/, 'a dropped png wider than 1024 draws from its preview');
  const served = await page.evaluate(async (url) => {
    const status = (await fetch(url)).status;
    const preview = new Image();
    preview.src = url;
    await preview.decode();
    return { status, width: preview.naturalWidth };
  }, drawnUrl);
  assert.deepEqual(served, { status: 200, width: 1024 }, 'a dropped picture draws from the served, capped preview');
  const pictureRect = await screenRectOf(open, picture.id);
  const pictureCenter = centerOf(pictureRect);
  assert.equal(await cursorAt(open, pictureCenter), 'zoom-in', 'a picture shows the zoom-in cursor');
  await page.mouse.click(pictureCenter.x, pictureCenter.y);
  const viewer = page.locator('.wb-image-viewer');
  const enlarged = viewer.locator('img.wb-image-viewer-picture');
  await enlarged.waitFor();
  const naturalWidth = await enlarged.evaluate(async (node) => (node instanceof HTMLImageElement ? node.decode().then(() => node.naturalWidth) : 0));
  assert.equal(naturalWidth, 2400, 'a clicked picture opens the original at its own size');
  assert.ok(await enlarged.evaluate((node) => node instanceof HTMLImageElement && node.src.endsWith('.png')), 'a clicked picture opens the original png');
  assert.ok(await enlarged.evaluate((node) => node.getBoundingClientRect().width > window.innerWidth * 0.8), 'the viewer scales a picture up to fill the screen');
  const viewerClose = viewer.locator('.wb-image-viewer-header').getByRole('button', { name: 'Close', exact: true });
  const closeBounds = await viewerClose.boundingBox();
  const enlargedBounds = await enlarged.boundingBox();
  assert.ok(closeBounds && enlargedBounds && closeBounds.y + closeBounds.height <= enlargedBounds.y, 'the viewer puts Close in its header above the picture');
  assert.equal(await viewer.locator('.dialog-actions').count(), 0, 'the viewer has no bottom actions row');
  await verifyViewerWidthHandle(page, enlarged);
  await verifyViewerZoom(page, enlarged, viewerClose);
  await viewerClose.click();
  await viewer.waitFor({ state: 'detached' });
  await verifyGesturesOverMedia(open, picture.id);
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await boardWithout(open, 'undo removes the dropped picture', titled('dropped-shot'));
}

const WIDE_TABLE_WIDTH_PX = 3000;
const PROBE_PAGE_HTML = `<!doctype html><html><body><input aria-label="probe field"><script>
const wideTableHost = document.createElement('div');
wideTableHost.style.height = '40px';
document.body.append(wideTableHost);
addEventListener('load', () => setTimeout(() => wideTableHost.attachShadow({ mode: 'open' }).innerHTML = '<table aria-label="wide table" style="width:${WIDE_TABLE_WIDTH_PX}px"><tr><td>first column</td><td style="text-align:right">last column</td></tr></table>', 1500));
addEventListener('keydown', (event) => event.stopImmediatePropagation(), true);
const readings = {};
try { readings.dom = String(parent.document.body.childElementCount); } catch { readings.dom = 'blocked'; }
try { readings.storage = String(localStorage.length); } catch { readings.storage = 'blocked'; }
try { readings.cookie = document.cookie; } catch { readings.cookie = 'blocked'; }
parent.postMessage({ boardPageProbe: readings }, '*');
</script></body></html>`;

async function webmClipBase64(): Promise<string> {
  const ffmpegPath = resolveFfmpegPath();
  assert.ok(ffmpegPath, 'ffmpeg-static is installed');
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'board-clip-'));
  const clipPath = path.join(workDirectory, 'clip.webm');
  await execFileAsync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest', '-y', clipPath]);
  const clipBase64 = fs.readFileSync(clipPath).toString('base64');
  fs.rmSync(workDirectory, { recursive: true, force: true });
  return clipBase64;
}

async function dropFileOnCanvas(panel: Locator, file: { name: string; type: string; base64: string }, offset: { x: number; y: number }): Promise<void> {
  await panel.locator('.wb-canvas').evaluate((canvas, { name, type, base64, offsetX, offsetY }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    const canvasRect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: canvasRect.left + offsetX, clientY: canvasRect.top + offsetY }));
  }, { ...file, offsetX: offset.x, offsetY: offset.y });
}

async function panTowardTopOfCanvas(panel: Locator, target: Locator): Promise<void> {
  const page = panel.page();
  const canvasBounds = await panel.locator('.wb-canvas').boundingBox();
  const targetBounds = await target.boundingBox();
  assert.ok(canvasBounds && targetBounds);
  await page.mouse.move(canvasBounds.x + canvasBounds.width / 2, canvasBounds.y + canvasBounds.height / 2);
  await page.mouse.wheel(targetBounds.x - (canvasBounds.x + canvasBounds.width / 3), targetBounds.y - (canvasBounds.y + 60));
}

async function verifyBoxAbovePageCoversIt(open: OpenBoard, pageMedia: Locator): Promise<void> {
  const { page, panel } = open;
  const pageMaskOf = () => pageMedia.evaluate((node) => getComputedStyle(node).maskImage || getComputedStyle(node).getPropertyValue('-webkit-mask-image'));
  assert.equal(await pageMaskOf(), 'none', 'a page box with nothing drawn above it is shown whole');
  const canvasBounds = await panel.locator('.wb-canvas').boundingBox();
  const pageBounds = await pageMedia.boundingBox();
  assert.ok(canvasBounds && pageBounds);
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('r');
  const boxAbove = await placeBoxWithTool(open, { x: pageBounds.x - canvasBounds.x + pageBounds.width * 0.7, y: pageBounds.y - canvasBounds.y + pageBounds.height * 0.6 }, 'Above the page');
  await page.waitForFunction(() => /data:image\/svg\+xml/.test(getComputedStyle(document.querySelector('.wb-media[data-media-kind="page"]') ?? document.body).maskImage));
  while ((await boardOf(open)).elements.get(boxAbove.id)) {
    const versionBeforeUndo = (await boardOf(open)).version;
    await panel.getByRole('button', { name: 'Undo', exact: true }).click();
    await pollFor('undo takes back one edit', BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeUndo ? true : null));
  }
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.wb-media[data-media-kind="page"]') ?? document.body).maskImage === 'none');
}

const DIALS_PAGE_HTML = `<!doctype html><script type="application/glimmervoid-params">[{"id":"speed","label":"Speed","kind":"range","min":0,"max":10,"default":4},{"id":"loud","label":"Loud","kind":"toggle"}]</script><input aria-label="dials field"><script>
addEventListener('glimmervoid:params', (event) => parent.postMessage({ boardPageParams: event.detail }, '*'));
</script>`;

async function verifyPageDials(open: OpenBoard): Promise<void> {
  const { page, panel } = open;
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      const dialValues: unknown = event.data?.boardPageParams;
      if (dialValues && typeof dialValues === 'object') document.documentElement.dataset.boardPageParams = JSON.stringify(dialValues);
    });
  });
  const postedDialValues = (expected: string) => page.waitForFunction((expectedText) => document.documentElement.dataset.boardPageParams === expectedText, expected, { timeout: BOARD_TIMEOUT_MS });
  await dropFileOnCanvas(panel, { name: 'dials.html', type: 'text/html', base64: Buffer.from(DIALS_PAGE_HTML).toString('base64') }, { x: 200, y: 300 });
  const isDialsPage = (element: BoardElement) => element.kind === 'box' && element.media?.kind === 'page' && element.media.alt === 'dials.html';
  const dialsBox = await elementWhere(open, 'the dropped page with dials', isDialsPage);
  assert.ok(dialsBox.kind === 'box' && dialsBox.shape !== 'icon' && dialsBox.media?.dials.length === 2, 'attach reads the dials the page declares');
  await postedDialValues(JSON.stringify({ speed: 4, loud: false }));
  const dialsMedia = panel.locator(`.wb-media[data-box-id="${dialsBox.id}"]`);
  assert.equal(await dialsMedia.locator('iframe').evaluate((frame) => getComputedStyle(frame).pointerEvents), 'auto', 'the selected page takes the pointer in place');
  const speedDial = panel.locator('[data-field="dial-speed"]');
  await speedDial.evaluate((slider) => {
    if (!(slider instanceof HTMLInputElement)) return;
    slider.value = '7';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await elementWhere(open, 'a dial change stores the value on the box', (element) => element.id === dialsBox.id && element.kind === 'box' && element.params.speed === 7);
  await postedDialValues(JSON.stringify({ speed: 7, loud: false }));
  await verifyCtrlWheelOverInteractivePageZoomsBoard(open, dialsMedia);
  await page.frameLocator(`.wb-media[data-box-id="${dialsBox.id}"] iframe`).getByLabel('dials field').focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction((boxId) => !document.querySelector(`.wb-media[data-box-id="${boxId}"]`)?.classList.contains('is-interactive'), dialsBox.id, { timeout: BOARD_TIMEOUT_MS });
  assert.equal(await dialsMedia.locator('iframe').evaluate((frame) => getComputedStyle(frame).pointerEvents), 'none', 'Esc inside the page hands the pointer back to the board');
  assert.equal(await dialsMedia.locator('iframe').evaluate((frame) => frame instanceof HTMLElement ? frame.style.width : ''), '1280px', 'a page on a plain box lays out 1280 wide');
  await controlReplyOf(page, 'whiteboard-op', { boardId: open.boardId, ops: [{ op: 'set', id: dialsBox.id, fields: { shape: 'device', device: 'phone' } }] });
  await page.waitForFunction((boxId) => document.querySelector<HTMLElement>(`.wb-media[data-box-id="${boxId}"] iframe`)?.style.width === '393px', dialsBox.id, { timeout: BOARD_TIMEOUT_MS })
    .catch(() => assert.fail('a page on a phone device box lays out at the phone screen width'));
  await controlReplyOf(page, 'whiteboard-op', { boardId: open.boardId, ops: [{ op: 'remove', id: dialsBox.id }] });
  await boardWithout(open, 'the dials page is removed', isDialsPage);
}

async function verifyCtrlWheelOverInteractivePageZoomsBoard({ page, panel }: OpenBoard, pageMedia: Locator): Promise<void> {
  const worldScale = () => panel.locator('.wb-world').evaluate((world) => new DOMMatrixReadOnly(getComputedStyle(world).transform).a);
  const scaleBefore = await worldScale();
  const pageBody = page.frameLocator(`.wb-media[data-box-id="${await pageMedia.getAttribute('data-box-id')}"] iframe`).locator('body');
  const ctrlWheel = (deltaY: number) => pageBody.dispatchEvent('wheel', { ctrlKey: true, deltaY, clientX: 20, clientY: 20, bubbles: true, cancelable: true });
  await ctrlWheel(-100);
  await page.waitForFunction((before) => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.wb-world') ?? document.body).transform).a > before, scaleBefore, { timeout: BOARD_TIMEOUT_MS }).catch(() => assert.fail('a ctrl wheel inside an interactive page zooms the board in'));
  await ctrlWheel(100);
  await pageBody.evaluate(() => parent.postMessage({ type: 'glimmervoid-board-page-gesture', gesture: 'pan', deltaX: 1e308, deltaY: 0 }, '*'));
  await page.waitForTimeout(100);
  assert.ok(Number.isFinite(await panel.locator('.wb-world').evaluate((world) => new DOMMatrixReadOnly(getComputedStyle(world).transform).e)), 'a page cannot pan the board camera to infinity');
  await page.waitForFunction((before) => Math.abs(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.wb-world') ?? document.body).transform).a - before) < 0.001, scaleBefore, { timeout: BOARD_TIMEOUT_MS }).catch(() => assert.fail('a ctrl wheel back inside the page zooms the board out to where it was'));
}

async function deselectAll({ page, panel }: OpenBoard): Promise<void> {
  await panel.locator('.wb-viewport').focus();
  await page.keyboard.press('Escape');
}

async function verifyLiveMedia(open: OpenBoard): Promise<void> {
  const { page, panel } = open;
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      const readings: unknown = event.data?.boardPageProbe;
      if (readings && typeof readings === 'object') document.documentElement.dataset.boardPageProbe = JSON.stringify(readings);
    });
  });
  await dropFileOnCanvas(panel, { name: 'clip.webm', type: 'video/webm', base64: await webmClipBase64() }, { x: 40, y: 260 });
  const isClip = (element: BoardElement) => element.kind === 'box' && element.media?.kind === 'video' && element.media.alt === 'clip.webm';
  const clip = await elementWhere(open, 'the dropped video box', isClip);
  assert.equal(await panel.locator('.wb-media[data-media-kind="video"], video').count(), 0, 'a video box draws only its first frame on the board');
  const posterBounds = await screenRectOf(open, clip.id);
  await page.mouse.click(posterBounds.x + posterBounds.width / 3, posterBounds.y + posterBounds.height / 3);
  const viewer = page.locator('.wb-image-viewer');
  const viewerVideo = viewer.locator('video.wb-image-viewer-video');
  await viewerVideo.waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video.wb-image-viewer-video');
    return Boolean(video && !video.paused && video.currentTime > 0);
  });
  assert.deepEqual(await viewerVideo.evaluate((video) => video instanceof HTMLVideoElement && [video.controls, video.muted]), [true, false], 'a click on a video box plays it full size with controls and sound');
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });
  const worldTransform = () => panel.locator('.wb-world').evaluate((world) => world instanceof HTMLElement ? world.style.transform : '');
  const transformBeforePan = await worldTransform();
  const videoBounds = await screenRectOf(open, clip.id);
  await page.mouse.move(videoBounds.x + 10, videoBounds.y + 10);
  await page.mouse.wheel(0, 40);
  assert.notEqual(await worldTransform(), transformBeforePan, 'a wheel over a video box pans the board');

  await dropFileOnCanvas(panel, { name: 'probe.html', type: 'text/html', base64: Buffer.from(PROBE_PAGE_HTML).toString('base64') }, { x: 40, y: 480 });
  const pageMedia = panel.locator('.wb-media[data-media-kind="page"]');
  await pageMedia.waitFor();
  await deselectAll(open);
  await panTowardTopOfCanvas(panel, pageMedia);
  const pageFrame = pageMedia.locator('iframe.wb-media-page');
  assert.equal(await pageFrame.getAttribute('sandbox'), 'allow-scripts allow-forms', 'a page box renders in a sandbox without same-origin');
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.boardPageProbe));
  await deselectAll(open);
  assert.deepEqual(JSON.parse(await page.evaluate(() => document.documentElement.dataset.boardPageProbe ?? '{}')), { dom: 'blocked', storage: 'blocked', cookie: 'blocked' }, 'a page box cannot read the dashboard DOM, storage or cookies');
  assert.equal(await pageFrame.evaluate((frame) => getComputedStyle(frame).pointerEvents), 'none', 'an idle page ignores the pointer');
  const idlePageBounds = await pageMedia.boundingBox();
  assert.ok(idlePageBounds);
  const cursorOverPage = await cursorAt(open, { x: idlePageBounds.x + idlePageBounds.width / 2, y: idlePageBounds.y + idlePageBounds.height / 2 });
  assert.equal(cursorOverPage, 'zoom-in', 'a page box shows the zoom-in cursor like a picture');
  await page.mouse.click(idlePageBounds.x + idlePageBounds.width / 2, idlePageBounds.y + idlePageBounds.height / 2);
  const viewerPage = viewer.locator('iframe.wb-image-viewer-page');
  await viewerPage.waitFor();
  assert.equal(await viewerPage.getAttribute('sandbox'), 'allow-scripts allow-forms', 'a click on a page box opens it full size in the same sandbox');
  assert.notEqual(await viewerPage.evaluate((frame) => getComputedStyle(frame).pointerEvents), 'none', 'the full size page takes the pointer');
  await verifyWidePageFitsWhole(page, viewerPage);
  await verifyViewerWidthHandle(page, viewerPage);
  await verifyViewerPageZoom(page, viewerPage);
  await page.frameLocator('iframe.wb-image-viewer-page').getByLabel('probe field').click();
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached', timeout: 5000 }).catch(() => assert.fail('Esc closes the full size page while focus is inside the page'));
  await page.mouse.click(idlePageBounds.x + idlePageBounds.width / 2, idlePageBounds.y + idlePageBounds.height / 2);
  await viewerPage.waitFor({ timeout: 5000 }).catch(() => assert.fail('a second click on the page opens it full size again'));
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await panel.locator('.wb-media button').count(), 0, 'a page box carries no overlay buttons');
  await verifyBoxAbovePageCoversIt(open, pageMedia);
  await pageFrame.evaluate((frame) => {
    frame.dataset.loadedOnce = '';
  });
  await deselectAll(open);
  const pageBounds = await pageMedia.boundingBox();
  assert.ok(pageBounds);
  await page.mouse.move(pageBounds.x + pageBounds.width / 3, pageBounds.y + pageBounds.height / 3);
  await page.mouse.down();
  await page.mouse.move(pageBounds.x + pageBounds.width / 3 + 40, pageBounds.y + pageBounds.height / 3 + 20, { steps: 8 });
  await page.mouse.up();
  const movedBounds = await pageMedia.boundingBox();
  assert.ok(movedBounds);
  assert.ok(movedBounds.x - pageBounds.x > 10, `dragging a page box moves it, moved ${movedBounds.x - pageBounds.x}px`);
  assert.equal(await pageFrame.getAttribute('data-loaded-once'), '', 'moving a page box keeps its loaded page instead of reloading it');
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await pageMedia.waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await boardWithout(open, 'undo removes the dropped video', isClip);
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
}

function viewerScaleOf(media: Locator): Promise<number> {
  return media.evaluate(async (node) => {
    await new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled)));
    const transform = getComputedStyle(node.closest('.wb-image-viewer-sheet') ?? node).transform;
    return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
  });
}

async function untilSheetWidthOf(page: Page, expectedWidth: number, message: string): Promise<void> {
  const lastWidth = await page.locator('.wb-image-viewer-sheet').evaluate((sheet, expected) => new Promise<number>((resolve) => {
    const giveUpAt = performance.now() + 3000;
    const check = () => {
      const width = sheet.getBoundingClientRect().width;
      if (Math.abs(width - expected) < 2 || performance.now() > giveUpAt) {
        resolve(width);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  }), expectedWidth);
  assert.ok(Math.abs(lastWidth - expectedWidth) < 2, `${message} (width ${lastWidth}, expected ${expectedWidth})`);
}

async function verifyViewerWidthHandle(page: Page, media: Locator): Promise<void> {
  const viewer = page.locator('.wb-image-viewer');
  const widthHandle = viewer.locator('.wb-image-viewer-resizer');
  await viewer.evaluate((dialog) => Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const fullWidth = (await viewer.locator('.wb-image-viewer-sheet').boundingBox())?.width;
  const handleBounds = await widthHandle.boundingBox();
  assert.ok(fullWidth && fullWidth > 600 && handleBounds, 'the viewer shows a width handle on the media edge');
  const grip = { x: handleBounds.x + handleBounds.width / 2, y: handleBounds.y + handleBounds.height / 2 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 300, grip.y, { steps: 6 });
  await page.mouse.up();
  await untilSheetWidthOf(page, fullWidth - 300, 'dragging the width handle narrows the media by the drag');
  assert.ok(((await media.boundingBox())?.width ?? 0) <= fullWidth - 299, 'the media fits inside its narrowed width');
  assert.equal(await viewerScaleOf(media), 1, 'dragging the width handle leaves the zoom at fit');
  const narrowedMedia = await media.boundingBox();
  const narrowedHandle = await widthHandle.boundingBox();
  assert.ok(narrowedMedia && narrowedHandle && narrowedMedia.x + narrowedMedia.width <= narrowedHandle.x + 0.5, 'the width handle sits beside the media, not over its scrollbar or controls');
  const mediaCenter = { x: narrowedMedia.x + narrowedMedia.width / 2, y: narrowedMedia.y + narrowedMedia.height / 2 };
  await page.mouse.move(mediaCenter.x, mediaCenter.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await untilScaleOf(media, 1.05, 8, 'a ctrl wheel zooms narrowed media');
  for (let push = 0; push < 6; push += 1) await page.mouse.wheel(1000, 0);
  const pannedRight = await settledBoundsOf(media);
  const stageBounds = await viewer.locator('.wb-image-viewer-stage').boundingBox();
  assert.ok(pannedRight && stageBounds && pannedRight.x + pannedRight.width > stageBounds.x + stageBounds.width / 2, `panning zoomed narrowed media keeps it on the stage (media right ${pannedRight ? pannedRight.x + pannedRight.width : 'none'})`);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 2000);
  await page.keyboard.up('Control');
  await untilScaleOf(media, 1, 1, 'a ctrl wheel back returns narrowed media to fit');
  await widthHandle.dblclick();
  await untilSheetWidthOf(page, fullWidth, 'a double click on the width handle returns the media to its fitted width');
  assert.equal(await viewerScaleOf(media), 1, 'a double click on the width handle does not zoom');
}

async function verifyWidePageFitsWhole(page: Page, viewerPage: Locator): Promise<void> {
  const wideTable = page.frameLocator('iframe.wb-image-viewer-page').getByRole('table', { name: 'wide table' });
  const stage = page.locator('.wb-image-viewer-stage');
  const fitsWhole = await page.waitForFunction(() => {
    const frame = document.querySelector('iframe.wb-image-viewer-page');
    const stageElement = document.querySelector('.wb-image-viewer-stage');
    return Boolean(frame instanceof HTMLIFrameElement && stageElement && frame.offsetWidth > stageElement.clientWidth);
  }, undefined, { timeout: BOARD_TIMEOUT_MS }).then(() => true, () => false);
  assert.ok(fitsWhole, 'a page wider than the viewer lays out at its content width');
  const pageLayout = await page.frameLocator('iframe.wb-image-viewer-page').locator('html').evaluate((root) => ({ scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }));
  assert.ok(pageLayout.scrollWidth <= pageLayout.clientWidth, `a fitted wide page scrolls no content sideways (${JSON.stringify(pageLayout)})`);
  const tableBounds = await wideTable.boundingBox();
  const stageBounds = await stage.boundingBox();
  assert.ok(tableBounds && stageBounds && tableBounds.x >= stageBounds.x && tableBounds.x + tableBounds.width <= stageBounds.x + stageBounds.width, `a wide table shows whole inside the viewer (table ${JSON.stringify(tableBounds)}, stage ${JSON.stringify(stageBounds)})`);
  assert.ok(((await viewerPage.boundingBox())?.width ?? 0) < (await viewerPage.evaluate((frame) => frame instanceof HTMLElement ? frame.offsetWidth : 0)), 'a fitted wide page is scaled down to the viewer');
}

async function verifyViewerPageZoom(page: Page, viewerPage: Locator): Promise<void> {
  await page.waitForFunction(() => document.querySelector('iframe.wb-image-viewer-page')?.getAnimations({ subtree: true }).length === 0);
  const frameBounds = await viewerPage.boundingBox();
  assert.ok(frameBounds);
  const center = { x: frameBounds.x + frameBounds.width / 2, y: frameBounds.y + frameBounds.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await untilScaleOf(viewerPage, 1.05, 8, 'a ctrl wheel inside a full size page zooms it');
  assert.ok(Math.abs(await viewerScaleOf(viewerPage) - 1.1) < 0.001, 'a ctrl wheel inside a full size page zooms the page by the board wheel step');
  const zoomedBounds = await settledBoundsOf(viewerPage);
  await page.mouse.wheel(0, 20);
  await page.waitForFunction((zoomedY) => (document.querySelector('iframe.wb-image-viewer-page')?.getBoundingClientRect().y ?? zoomedY) !== zoomedY, zoomedBounds?.y ?? 0);
  assert.equal(Math.round((zoomedBounds?.y ?? 0) - ((await settledBoundsOf(viewerPage))?.y ?? 0)), 20, 'a plain wheel inside a zoomed page pans it');
  const beforeDrag = await settledBoundsOf(viewerPage);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x, center.y + 15, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((targetY) => Math.round((document.querySelector('iframe.wb-image-viewer-page')?.getBoundingClientRect().y ?? 0) - targetY) === 0, (beforeDrag?.y ?? 0) + 15, { timeout: BOARD_TIMEOUT_MS }).catch(() => undefined);
  assert.equal(Math.round(((await settledBoundsOf(viewerPage))?.y ?? 0) - (beforeDrag?.y ?? 0)), 15, 'a mouse drag inside a zoomed page pans it');
  await viewerPage.evaluate((frame) => new Promise((resolve) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.setAttribute('src', frame.getAttribute('src') ?? '');
  }));
  const beforeReloadWheel = await settledBoundsOf(viewerPage);
  await page.mouse.wheel(0, 10);
  await page.waitForFunction((reloadY) => document.querySelector('iframe.wb-image-viewer-page')?.getBoundingClientRect().y !== reloadY, beforeReloadWheel?.y ?? 0);
  await page.mouse.dblclick(center.x, center.y);
  await untilScaleOf(viewerPage, 1, 1, 'a double click or double tap inside a zoomed page returns it to fit');
  await pinchOn(page, center, 60, 180);
  await untilScaleOf(viewerPage, 2.01, 8, 'a two finger pinch inside a full size page zooms it');
  await doubleTapOn(page, center);
  await untilScaleOf(viewerPage, 1, 1, 'a double click or double tap inside a zoomed page returns it to fit');
}

async function untilScaleOf(media: Locator, leastScale: number, mostScale: number, message: string): Promise<void> {
  const lastScale = await media.evaluate((element, [least, most]) => new Promise<number>((resolve) => {
    const giveUpAt = performance.now() + 3000;
    const check = () => {
      const scale = new DOMMatrixReadOnly(getComputedStyle(element.closest('.wb-image-viewer-sheet') ?? element).transform).a;
      if ((scale >= least && scale <= most) || performance.now() > giveUpAt) {
        resolve(scale);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  }), [leastScale, mostScale]);
  assert.ok(lastScale >= leastScale && lastScale <= mostScale, `${message} (scale ${lastScale})`);
}

async function doubleTapOn(page: Page, point: { x: number; y: number }): Promise<void> {
  const touchSession = await page.context().newCDPSession(page);
  try {
    for (let tap = 0; tap < 2; tap += 1) {
      await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  } finally {
    await touchSession.detach();
  }
}

async function pinchOn(page: Page, center: { x: number; y: number }, fromGap: number, toGap: number): Promise<void> {
  const touchSession = await page.context().newCDPSession(page);
  const pointsAt = (gap: number) => [{ x: center.x - gap / 2, y: center.y, id: 1 }, { x: center.x + gap / 2, y: center.y, id: 2 }];
  try {
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pointsAt(fromGap) });
    for (let step = 1; step <= 6; step += 1) await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pointsAt(fromGap + ((toGap - fromGap) * step) / 6) });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await touchSession.detach();
  }
}

async function settledBoundsOf(media: Locator): ReturnType<Locator['boundingBox']> {
  await viewerScaleOf(media);
  return media.boundingBox();
}

async function verifyViewerZoom(page: Page, media: Locator, viewerClose: Locator): Promise<void> {
  const fitted = await settledBoundsOf(media);
  await viewerClose.evaluate((node) => Promise.all((node.closest('.dialog')?.getAnimations({ subtree: true }) ?? []).map((animation) => animation.finished)));
  const closeBefore = JSON.stringify(await viewerClose.boundingBox());
  assert.ok(fitted && closeBefore, 'the viewer media and Close have bounds');
  const center = { x: fitted.x + fitted.width / 2, y: fitted.y + fitted.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  assert.ok(Math.abs((await viewerScaleOf(media)) - 1.1) < 0.01, 'a ctrl wheel over viewer media zooms it one board step');
  assert.equal(JSON.stringify(await viewerClose.boundingBox()), closeBefore, 'zooming the media leaves the viewer header alone');
  const beforePan = await settledBoundsOf(media);
  await page.mouse.wheel(0, 20);
  const afterPan = await settledBoundsOf(media);
  assert.ok(beforePan && afterPan && Math.abs(beforePan.y - afterPan.y - 20) < 1.5, 'a plain wheel pans zoomed media');
  await page.mouse.dblclick(center.x, center.y);
  await untilScaleOf(media, 1, 1, 'a double click on zoomed media returns it to fit');
  await page.mouse.dblclick(center.x, center.y);
  await untilScaleOf(media, 2, 2, 'a double click at fit zooms the media to 2x');
  const beforeDrag = await settledBoundsOf(media);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 80, center.y, { steps: 5 });
  await page.mouse.up();
  const afterDrag = await settledBoundsOf(media);
  assert.ok(beforeDrag && afterDrag && Math.abs(beforeDrag.x - afterDrag.x - 80) < 1.5, 'a drag pans zoomed media');
  await page.mouse.dblclick(center.x, center.y);
  await page.mouse.wheel(0, 40);
  assert.equal(await viewerScaleOf(media), 1, 'zoom never goes below fit');
  await pinchOn(page, center, 60, 180);
  assert.ok((await viewerScaleOf(media)) > 2, 'a two finger pinch over viewer media zooms it');
  assert.equal(JSON.stringify(await viewerClose.boundingBox()), closeBefore, 'a pinch leaves the viewer header alone');
  await verifyViewerZoomEdges(page, media, viewerClose, center);
}

async function verifyViewerZoomEdges(page: Page, media: Locator, viewerClose: Locator, center: { x: number; y: number }): Promise<void> {
  const viewport = page.viewportSize();
  assert.ok(viewport, 'the page has a viewport');
  await page.setViewportSize({ width: Math.round(viewport.width * 0.6), height: Math.round(viewport.height * 0.6) });
  const stageCovered = await media.evaluate(async (node) => {
    await new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled)));
    const mediaRect = node.getBoundingClientRect();
    const stageRect = node.parentElement?.getBoundingClientRect();
    return Boolean(stageRect && mediaRect.left <= stageRect.left + 1 && mediaRect.top <= stageRect.top + 1 && mediaRect.right >= stageRect.right - 1 && mediaRect.bottom >= stageRect.bottom - 1);
  });
  await page.setViewportSize(viewport);
  assert.ok(stageCovered, 'zoomed media still covers the stage after the viewer shrinks');
  const closeBounds = await viewerClose.boundingBox();
  assert.ok(closeBounds, 'Close has bounds');
  const isHeaderZoomCancelled = await viewerClose.evaluate((node) => {
    const zoomWheel = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    node.dispatchEvent(zoomWheel);
    return zoomWheel.defaultPrevented;
  });
  assert.ok(isHeaderZoomCancelled, 'a ctrl wheel over the viewer header never zooms the dashboard');
  await page.mouse.dblclick(center.x, center.y);
  await untilScaleOf(media, 1, 1, 'a double click on pinched media returns it to fit');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(closeBounds.x - 40, closeBounds.y + closeBounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(center.x, center.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const beforeHover = await settledBoundsOf(media);
  await page.mouse.move(center.x - 100, center.y, { steps: 4 });
  const afterHover = await settledBoundsOf(media);
  assert.deepEqual(afterHover, beforeHover, 'moving the mouse with no button held never pans the media');
}

async function verifyGesturesOverMedia(open: OpenBoard, pictureId: string): Promise<void> {
  const { page, panel } = open;
  const resting = await screenRectOf(open, pictureId);
  const anchor = { x: resting.x + resting.width / 4, y: resting.y + resting.height / 2 };
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const zoomed = await screenRectOf(open, pictureId);
  assert.ok(Math.abs(zoomed.width / resting.width - 1.1) < 0.01, 'a ctrl wheel over a picture zooms the board one step');
  assert.ok(Math.abs(zoomed.x + (anchor.x - resting.x) * 1.1 - anchor.x) < 1.5, 'zooming keeps the point under the pointer still');
  await page.mouse.wheel(0, 60);
  const panned = await screenRectOf(open, pictureId);
  assert.ok(Math.abs(zoomed.y - panned.y - 60) < 1.5, 'a wheel over a picture pans the board');
  const versionBeforeDrag = (await boardOf(open)).version;
  await page.mouse.move(panned.x + panned.width / 2, panned.y + panned.height / 2);
  await page.mouse.down();
  await page.mouse.move(panned.x + panned.width / 2 + 120, panned.y + panned.height / 2, { steps: 6 });
  await page.mouse.up();
  await pollFor('dragging a picture box saves its move', BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeDrag ? true : null));
  const dragged = await screenRectOf(open, pictureId);
  assert.ok(Math.abs(dragged.x - panned.x - 120) < 2, 'dragging a picture box moves it with the pointer');
  assert.equal(await page.locator('.wb-image-viewer').count(), 0, 'dragging a picture does not open the viewer');
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
}

async function renameOpenBoard(page: Page, panel: Locator, currentTitle: string, typedTitle: string, finishKey: 'Enter' | 'Escape'): Promise<void> {
  await panel.locator('.wb-board-title', { hasText: currentTitle }).click();
  await panel.getByRole('textbox', { name: 'Board title', exact: true }).fill(typedTitle);
  await page.keyboard.press(finishKey);
  const expectedTitle = finishKey === 'Enter' ? typedTitle : currentTitle;
  await panel.getByRole('button', { name: expectedTitle, exact: true }).waitFor();
  assert.equal(await panel.getByRole('textbox', { name: 'Board title', exact: true }).count(), 0);
}

async function openBoardMenuItem(page: Page, panel: Locator, itemName: string): Promise<void> {
  await panel.getByRole('button', { name: 'Board actions', exact: true }).click();
  await page.getByRole('menuitem', { name: itemName, exact: true }).click();
}

async function createBoardFromView(page: Page, panel: Locator, boardTitle: string): Promise<void> {
  const emptyNewBoard = panel.locator('.wb-empty').getByRole('button', { name: 'new board', exact: true });
  if (await emptyNewBoard.isVisible()) await emptyNewBoard.click();
  if (!(await page.getByRole('textbox', { name: 'Board title', exact: true }).isVisible())) await openBoardMenuItem(page, panel, 'New board');
  await submitTextDialog(page, 'Board title', boardTitle, 'Create board');
  await openBoardTitle(panel, boardTitle).waitFor();
}

function openBoardTitle(panel: Locator, boardTitle: string): Locator {
  return panel.locator('.wb-board-title', { hasText: boardTitle });
}

async function controlReplyOf(page: Page, type: string, payload: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async ({ type, payload }) => {
    const tokenReply: unknown = await fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json());
    const token = typeof tokenReply === 'object' && tokenReply !== null && 'token' in tokenReply && typeof tokenReply.token === 'string' ? tokenReply.token : '';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/control?token=${encodeURIComponent(token)}`);
    const requestId = `harness-${type}-${Date.now()}-${Math.random()}`;
    return new Promise<unknown>((resolve, reject) => {
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type, requestId, ...payload })));
      socket.addEventListener('error', () => reject(new Error(`${type} could not reach the control socket`)));
      socket.addEventListener('message', (event) => {
        const reply: unknown = JSON.parse(String(event.data));
        if (typeof reply !== 'object' || reply === null || !('requestId' in reply) || reply.requestId !== requestId) return;
        socket.close();
        if ('ok' in reply && reply.ok === true) {
          resolve(reply);
          return;
        }
        reject(new Error(`${type} was refused: ${JSON.stringify(reply)}`));
      });
    });
  }, { type, payload });
}

async function createBoardOverControl(page: Page, boardTitle: string): Promise<string> {
  return CreatedReply.parse(await controlReplyOf(page, 'whiteboard-create', { title: boardTitle })).summary.id;
}

async function showBoardInFocus(page: Page, sessionId: string, boardTitle: string): Promise<Locator> {
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  await page.locator('#focus-pane-board').waitFor({ state: 'visible' });
  const center = page.locator('#focus-center');
  await openBoardTitle(center, boardTitle).waitFor();
  return center;
}

async function submitTextDialog(page: Page, label: string, value: string, confirmLabel: string): Promise<void> {
  await page.getByRole('textbox', { name: label, exact: true }).fill(value);
  await page.getByRole('button', { name: confirmLabel, exact: true }).click();
}

export async function verifyBoards(page: Page, layout: Layout, sessionId: string): Promise<void> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  if (layout === 'phone') {
    const navButtonLabels = await page.locator('.phone-nav > .phone-nav-item:not([hidden]) .phone-nav-label').allTextContents();
    assert.deepEqual(navButtonLabels, ['Focus', 'Terminal', 'Boards', 'More']);
    assert.equal(await page.locator('.phone-nav-more-menu [data-screen="boards"]').count(), 0);
    const boardsNavButton = page.locator('.phone-nav > .phone-nav-item[data-screen="boards"]');
    await boardsNavButton.click();
    assert.equal(await boardsNavButton.getAttribute('aria-current'), 'page');
  }
  const boardTitle = `Ingest plan ${layout}`;
  const desktopBoard = layout === 'desktop' ? await openDesktopBoard(page, sessionId, boardTitle) : null;
  const panel = desktopBoard?.panel ?? page.locator('.boards-view');
  await panel.waitFor({ state: 'visible' });
  if (layout === 'phone') await createBoardFromView(page, panel, boardTitle);
  await panel.locator('.wb-viewport').waitFor({ state: 'visible' });
  if (layout === 'phone') {
    await panel.getByRole('button', { name: 'Board actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New board', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: 'Board settings', exact: true }).isVisible(), false, 'phone hides the properties panel, so the menu offers no board settings');
    await page.keyboard.press('Escape');
  }
  if (desktopBoard) {
    const open = desktopBoard;
    assert.equal(await panel.locator('.wb-inspect').isVisible(), false, 'no properties panel covers the canvas with nothing selected');
    const canvasBounds = await panel.locator('.wb-canvas').boundingBox();
    const toolsIslandBounds = await panel.getByRole('toolbar', { name: 'Board tools', exact: true }).boundingBox();
    assert.ok(canvasBounds && toolsIslandBounds);
    const titleIslandBounds = await panel.getByRole('toolbar', { name: 'Board', exact: true }).boundingBox();
    const viewIslandBounds = await panel.getByRole('toolbar', { name: 'View', exact: true }).boundingBox();
    assert.ok(titleIslandBounds && viewIslandBounds);
    assert.ok(toolsIslandBounds.y >= canvasBounds.y && viewIslandBounds.y >= canvasBounds.y, 'the view controls and tools sit inside the Board pane, not in the tab strip');
    assert.ok(titleIslandBounds.y + titleIslandBounds.height <= canvasBounds.y, 'the board menu, name and version sit in the Board pane header, above the canvas');
    const renamedTitle = `${boardTitle} renamed`;
    await renameOpenBoard(page, panel, boardTitle, renamedTitle, 'Enter');
    await renameOpenBoard(page, panel, renamedTitle, 'discarded title', 'Escape');
    await renameOpenBoard(page, panel, renamedTitle, boardTitle, 'Enter');
    const boxTool = drawingTool(panel, 'Box');
    assert.equal(await boxTool.getAttribute('title'), null, 'a board tool has no native tooltip');
    await boxTool.click();
    assert.equal(await boxTool.getAttribute('aria-pressed'), 'true');
    const toolHint = panel.locator('.wb-tool-hint');
    await toolHint.filter({ hasText: 'Click the board to place a box' }).waitFor();
    const parseFeed = await placeBoxWithTool(open, { x: 60, y: 60 }, 'Parse feed');
    assert.equal(await drawingTool(panel, 'Select').getAttribute('aria-pressed'), 'true', 'the tool returns to select after one placement');
    assert.equal(await toolHint.isVisible(), false, 'the hint line hides once the select tool is back');
    await panel.locator('.wb-viewport').focus();
    await page.keyboard.press('Escape');
    await panel.locator('.wb-inspect').waitFor({ state: 'hidden' });
    await verifyResizedBoxes(open, [parseFeed.id]);
    await verifyStacking(open, parseFeed.id);
    await verifyNoteShapes(open);
    await verifyLineEditing(open);
    await verifyPageDials(open);
    await verifyDroppedPicture(open);
    await verifyLiveMedia(open);
    if (desktopBoard) await verifyBoardDoc(open);
    const isComicMonoLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('700 16px ComicMono');
    });
    assert.equal(isComicMonoLoaded, true);
    const canvasBox = await panel.locator('.wb-canvas').boundingBox();
    const boxOutline = await screenRectOf(open, parseFeed.id);
    assert.ok(canvasBox);
    assert.ok(boxOutline.x >= canvasBox.x && boxOutline.y >= canvasBox.y, 'the box starts inside the canvas');
    assert.ok(boxOutline.x + boxOutline.width <= canvasBox.x + canvasBox.width && boxOutline.y + boxOutline.height <= canvasBox.y + canvasBox.height, 'the box ends inside the canvas');
    await page.mouse.dblclick(boxOutline.x + 40, boxOutline.y + boxOutline.height / 2);
    await page.getByRole('textbox', { name: 'Box title', exact: true }).fill('Parse and store');
    await page.keyboard.press('Enter');
    const sourceBox = await elementWhere(open, 'the renamed box', titled('Parse and store'));
    await panel.locator('.wb-viewport').focus();
    await page.keyboard.press('r');
    const targetBox = await placeBoxWithTool(open, { x: 60, y: 260 }, 'Index rows');
    await panel.locator('.wb-viewport').focus();
    assert.deepEqual(await drawingTools(panel).getByRole('button').evaluateAll((tools) => tools.map((tool) => tool.getAttribute('aria-label'))), ['Select', 'Box', 'Note', 'Text', 'Wire', 'Pen'], 'the toolbar shows six tools');
    await page.keyboard.press('d');
    const priorArt = await placeBoxWithTool(open, { x: 40, y: 440 }, 'Prior art');
    assert.ok(priorArt.kind === 'box' && priorArt.shape === 'decision', 'the D key still places a decision with no toolbar button');
    await verifyBoxStaysWhereDropped(open, priorArt.id, 'a decision placed with the D key');
    await selectBoxes(open, [sourceBox.id, targetBox.id]);
    await verifyResizedBoxes(open, [sourceBox.id, targetBox.id]);
    await page.keyboard.press('Escape');
    const sourceRect = await screenRectOf(open, sourceBox.id);
    await page.mouse.move(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2);
    const bottomPort = { x: sourceRect.x + sourceRect.width / 2, y: sourceRect.y + sourceRect.height };
    assert.equal(await cursorAt(open, bottomPort), 'crosshair', 'the bottom edge middle of a hovered box is a wire port');
    const dropTarget = centerOf(await screenRectOf(open, targetBox.id));
    await page.mouse.down();
    await page.mouse.move(dropTarget.x, dropTarget.y, { steps: 6 });
    assert.equal(await panel.locator('.wb-wire-draft').count(), 1, 'a port drag draws a dashed line');
    await page.mouse.up();
    assert.equal(await panel.locator('.wb-wire-draft').count(), 0, 'releasing a port drag removes its dashed line');
    const wire = await elementWhere(open, 'the dragged wire', (element) => element.kind === 'wire' && element.from === sourceBox.id && element.to === targetBox.id);
    const restingPath = await wirePathOf(open, wire.id);
    const restingTarget = await screenRectOf(open, targetBox.id);
    const versionBeforeDrop = (await boardOf(open)).version;
    await page.mouse.move(restingTarget.x + restingTarget.width / 2, restingTarget.y + restingTarget.height / 2);
    await page.mouse.down();
    await page.mouse.move(restingTarget.x + restingTarget.width / 2 + 260, restingTarget.y + restingTarget.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await pollFor('dropping the dragged box saves its move', BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBeforeDrop ? true : null));
    const draggedPath = await wirePathOf(open, wire.id);
    assert.notEqual(draggedPath, restingPath, 'moving a box reroutes its wire');
    const stepHistory = async (label: string, press: () => Promise<void>, expectedPath: string) => {
      const versionBefore = (await boardOf(open)).version;
      await press();
      await pollFor(label, BOARD_TIMEOUT_MS, async () => ((await boardOf(open)).version !== versionBefore ? true : null));
      assert.equal(await wirePathOf(open, wire.id), expectedPath, label);
    };
    await panel.locator('.wb-viewport').focus();
    await stepHistory('undo puts the dragged box back', () => page.keyboard.press('ControlOrMeta+z'), restingPath);
    await stepHistory('redo moves it again', () => page.keyboard.press('ControlOrMeta+Shift+z'), draggedPath);
    await stepHistory('the undo button steps back like Ctrl+Z', () => panel.getByRole('button', { name: 'Undo', exact: true }).click(), restingPath);
    await stepHistory('the redo button steps forward again', () => panel.getByRole('button', { name: 'Redo', exact: true }).click(), draggedPath);
    await panel.locator('.wb-viewport').focus();
    const inspect = panel.locator('.wb-inspect');
    await page.keyboard.press('Escape');
    await inspect.waitFor({ state: 'hidden' });
    await openBoardMenuItem(page, panel, 'Board settings');
    await inspect.getByRole('heading', { name: 'Board', exact: true }).waitFor();
    await inspect.getByRole('combobox', { name: 'Code session', exact: true }).waitFor();
    assert.equal(await inspect.locator('[data-field="board-title"]').count(), 0, 'board settings carry no title field; rename stays on the board menu and the title click');
    assert.equal(await inspect.getByRole('textbox', { name: 'Legend label for plain wires', exact: true }).getAttribute('placeholder'), 'not shown', 'the legend offers one label per wire style the board uses, its default as the placeholder');
    assert.equal(await inspect.locator('[data-field^="legend-"]').count(), 1, 'a board with only plain wires offers one legend label');
    await page.keyboard.press('Escape');
    await inspect.waitFor({ state: 'hidden' });
    await panel.getByRole('button', { name: 'Board actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete board', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitemradio').count(), 0, 'the board menu holds only board actions, never a board list');
    await page.keyboard.press('Escape');
    await clickElement(open, targetBox.id);
    await waitForPressedShape(inspect, 'box');
    const isTargetWith = (isMatch: (box: Extract<BoardElement, { kind: 'box' }>) => boolean) => (element: BoardElement) => element.id === targetBox.id && element.kind === 'box' && isMatch(element);
    await inspect.getByRole('checkbox', { name: 'Borderless', exact: true }).check();
    await elementWhere(open, 'the box dropped its card', isTargetWith((box) => box.shape === 'box' && box.borderless === true));
    await inspect.getByRole('group', { name: 'Shape', exact: true }).getByRole('button', { name: 'Decision', exact: true }).click();
    await elementWhere(open, 'the box turned into a decision', isTargetWith((box) => box.shape === 'decision'));
    await waitForPressedShape(inspect, 'decision');
    await inspect.getByRole('combobox', { name: 'Step', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await elementWhere(open, 'undo right after a panel change takes the decision back', isTargetWith((box) => box.shape !== 'decision'));
    await waitForPressedShape(inspect, 'box');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await waitForPressedShape(inspect, 'decision');
    const titleField = inspect.getByRole('textbox', { name: 'Title', exact: true });
    await titleField.fill('Index first');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the panel title edit', titled('Index first'));
    await titleField.fill('Index second');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the second panel title edit', titled('Index second'));
    await inspect.getByRole('combobox', { name: 'Step', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await elementWhere(open, 'two undos take both title edits back', titled('Index rows'));
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await elementWhere(open, 'redo brings the first title back', titled('Index first'));
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await elementWhere(open, 'redo brings the second title back', titled('Index second'));
    assert.equal(await isMoreOpenIn(inspect), false, 'More stays closed while none of its fields is set');
    await openMoreIn(inspect);
    await inspect.getByRole('combobox', { name: 'Change', exact: true }).selectOption({ label: 'Renamed' });
    await elementWhere(open, 'a relabeled box keeps its old title', isTargetWith((box) => box.change === 'relabeled' && box.was === 'Index second'));
    await titleField.fill('Index rows by day');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the relabeled box takes its new title', isTargetWith((box) => box.change === 'relabeled' && box.title === 'Index rows by day'));
    assert.ok(layoutBoard(await boardOf(open)).legend.some((row) => row.label === 'renamed, old title struck through'), 'the legend explains a relabeled box');
    await inspect.getByRole('button', { name: 'Add a ref to this box', exact: true }).click();
    const refField = inspect.getByRole('textbox', { name: 'Ref 1', exact: true });
    await refField.fill('src/feed.ts#L2');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.boards-view .wb-inspect [data-field="ref-0"]')?.value === 'src/feed.ts#L2');
    await inspect.getByRole('combobox', { name: 'Change', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.boards-view .wb-inspect [data-field="ref-0"]')?.value === 'README.md');
    await inspect.getByRole('button', { name: 'Add a line to this box', exact: true }).click();
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).waitFor();
    await inspect.getByRole('button', { name: 'Add a line to this box', exact: true }).click();
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).waitFor();
    const hasLine = (text: string) => isTargetWith((box) => box.lines.some((line) => line.text === text));
    await inspect.getByRole('textbox', { name: 'Line 1 text', exact: true }).fill('first edited');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'the first line edit', hasLine('first edited'));
    await inspect.getByRole('textbox', { name: 'Line 2 text', exact: true }).fill('second edited');
    await page.keyboard.press('Enter');
    await elementWhere(open, 'a second line edit keeps the first one', (element) => hasLine('second edited')(element) && hasLine('first edited')(element));
    const step = await addPlanStep(open, { x: 60, y: 260 }, 'Index the diffs');
    await panel.locator('.wb-viewport').focus();
    await page.keyboard.press('Escape');
    await inspect.waitFor({ state: 'hidden' });
    await clickElement(open, step.id);
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('.boards-view .wb-inspect [data-field="step"]')?.value === 'planned');
    await inspect.getByRole('combobox', { name: 'Step', exact: true }).selectOption({ label: 'Landed' });
    await elementWhere(open, 'the landed step', (element) => element.id === step.id && element.kind === 'box' && element.step?.status === 'landed');
    await panel.locator('.wb-viewport').focus();
    await page.keyboard.press('Escape');
    await inspect.waitFor({ state: 'hidden' });
    await verifyBoxStaysWhereDropped(open, step.id, 'a plan step');
    await openBoardMenuItem(page, panel, 'Board settings');
    await inspect.getByRole('heading', { name: 'Board', exact: true }).waitFor({ timeout: 3000 });
  }
  assert.equal(await panel.getByRole('button', { name: 'Fit', exact: true }).isVisible(), true);
  assert.equal(await panel.getByRole('button', { name: boardTitle, exact: true }).count(), 1);
}

async function openDesktopBoard(page: Page, sessionId: string, boardTitle: string): Promise<OpenBoard> {
  assert.equal(await page.locator('#tab-boards').isVisible(), false, 'Boards has no desktop header tab; boards live in Focus');
  const boardId = await createBoardOverControl(page, boardTitle);
  await controlReplyOf(page, 'whiteboard-connect', { boardId, sessionId });
  return { page, panel: await showBoardInFocus(page, sessionId, boardTitle), boardId };
}

async function verifyTerminalHeaderNamesTheTask(card: Locator): Promise<void> {
  const header = card.locator(':scope > .session-card-header');
  const sessionNameLabel = header.locator('.session-name');
  const taskTitle = header.locator('.session-task-title');
  assert.equal(await sessionNameLabel.isVisible(), true, 'with no task title the terminal header names the session');
  await taskTitle.click();
  await taskTitle.locator('input').fill('Check the pane header');
  await taskTitle.locator('input').press('Enter');
  await taskTitle.filter({ hasText: 'Check the pane header' }).waitFor();
  await sessionNameLabel.waitFor({ state: 'hidden' });
  await taskTitle.click();
  await taskTitle.locator('input').fill('');
  await taskTitle.locator('input').press('Enter');
  await sessionNameLabel.waitFor({ state: 'visible' });
}

export async function verifyBoardPane(page: Page, sessionId: string, projectDirectory: string): Promise<void> {
  const boardTitle = `Pane plan ${sessionId.slice(0, 8)}`;
  const boardId = await createBoardOverControl(page, boardTitle);
  await page.locator(`.focus-rail .session-row[data-id="${sessionId}"] .session-row-glyph`).first().click();
  const card = page.locator(`.session-card[data-id="${sessionId}"]`).first();
  await card.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pane-layout').getAttribute('data-direction'), 'single', 'a session with no board shows Terminal only');
  assert.equal(await page.locator('.pane-tab').count(), 0, 'Focus shows no pane tabs');
  await card.getByRole('button', { name: 'Session actions', exact: true }).click();
  await card.locator('.overflow-connect-board').click();
  await page.getByRole('combobox', { name: 'Board to connect', exact: true }).selectOption({ label: boardTitle });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#focus-pane-board').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#focus-pane-terminal').isVisible(), true, 'a board arriving for the centered session splits the pane and keeps Terminal showing');
  assert.notEqual(await page.locator('.pane-layout').getAttribute('data-direction'), 'single', 'a board arriving for the centered session opens the stored split');
  assert.equal(await splitBoardTitleOf(page, sessionId), boardTitle, 'the rail shows the session and its board as one split item');
  await verifyTerminalHeaderNamesTheTask(card);
  const splitRow = page.locator(`.focus-rail .session-row[data-id="${sessionId}"][data-split]`);
  assert.equal(await splitRow.locator(`.session-board-chip[aria-label="Open board ${boardTitle}"]`).count(), 0, 'the split item names its board once, with no board link line repeating it');
  const splitBoardHalf = splitRow.locator('.session-row-split-board');
  const worktreePath = await pollFor('the session worktree', WORKTREE_TIMEOUT_MS, () => findSessionWorktree(projectDirectory));
  await commitFile(worktreePath, UNCOVERED_FILE_NAME, 'changed outside any board ref\n', 'test: a change no board ref covers');
  assert.equal(await splitBoardHalf.locator('.pr-status-icon').count(), 1, 'the board half carries the board icon');
  await splitBoardHalf.click();
  const panel = page.locator('#focus-center');
  const open: OpenBoard = { page, panel, boardId };
  await openBoardTitle(panel, boardTitle).waitFor();
  await verifyBoardToolsInBoardPane(panel, boardTitle);
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  const cardBox = await card.boundingBox();
  assert.ok(canvasBox && cardBox);
  assert.ok(canvasBox.x >= cardBox.x + cardBox.width, 'the default layout puts the board right of the terminal');
  await page.waitForFunction((id) => document.querySelector(`#focus-pane-terminal .session-card[data-id="${id}"]`)?.getAttribute('data-grid') === 'exact', sessionId);
  const agentIsland = panel.getByRole('toolbar', { name: 'Session', exact: true });
  assert.equal(await agentIsland.isVisible(), false, 'the session island stays hidden while the session has read every change');
  const centeredSessionName = await card.getAttribute('data-session');
  assert.ok(centeredSessionName);
  assert.equal(await panel.locator('.wb-presence-pill:not(.wb-presence-count)', { hasText: centeredSessionName }).count(), 0, 'the strip does not repeat the centered session as a presence pill');
  const step = await addPlanStep(open, { x: 60, y: 260 }, 'Uncovered change');
  await agentIsland.locator('.wb-session-queued', { hasText: 'queued for' }).waitFor();
  const agentBox = await agentIsland.boundingBox();
  assert.ok(agentBox);
  assert.ok(Math.abs(agentBox.y + agentBox.height - (canvasBox.y + canvasBox.height - 10)) < 2 && Math.abs(agentBox.x - (canvasBox.x + 10)) < 2, 'the session island sits bottom left on the board');
  assert.equal(await agentIsland.getByRole('button').count(), 0, 'the session island holds no send control, since board changes reach the agent with its next prompt');
  const inspect = panel.locator('.wb-inspect');
  await openMoreIn(inspect);
  await inspect.getByRole('button', { name: 'Add a ref to this box', exact: true }).click();
  await inspect.getByRole('textbox', { name: 'Ref 1', exact: true }).fill(UNCOVERED_FILE_NAME);
  await page.keyboard.press('Enter');
  await pollFor('the review flags the uncovered step', REVIEW_TIMEOUT_MS, async () => ((await reviewOf(open)).flaggedStepIds.includes(step.id) ? true : null));
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
  const fittedStepBox = await screenRectOf(open, step.id);
  const islandBox = await agentIsland.boundingBox();
  assert.ok(islandBox);
  const spaceAboveStepPx = fittedStepBox.y - canvasBox.y;
  const spaceBelowStepPx = islandBox.y - (fittedStepBox.y + fittedStepBox.height);
  assert.ok(spaceAboveStepPx > 0 && spaceBelowStepPx > 0, 'fit keeps the board clear of the session island');
  await inspect.getByRole('button', { name: `Open ${UNCOVERED_FILE_NAME} in review`, exact: true }).click();
  await page.locator('#tab-focus[aria-selected="true"]').waitFor();
  await page.locator(`.review-reader .review-reader-file[data-path="${UNCOVERED_FILE_NAME}"][aria-current="true"]`).waitFor({ timeout: REVIEW_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator('.review-reader').waitFor({ state: 'detached' });
  const toolbarTops = await panel.locator('.wb-top-left > .wb-island:not([hidden])').evaluateAll((islands) => islands.map((island) => Math.round(island.getBoundingClientRect().top)));
  assert.equal(new Set(toolbarTops).size, 1, `the board toolbars share one row, tops ${toolbarTops.join(', ')}`);
  await inspect.getByRole('button', { name: 'Delete', exact: true }).click();
  await boardWithout(open, 'the deleted step', (element) => element.id === step.id);
  await inspect.waitFor({ state: 'hidden' });
  await controlReplyOf(page, 'whiteboard-op', { boardId: open.boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'band-step', title: 'Band step', place: 'plan', step: { status: 'building' } } }] });
  const bandStep = await elementWhere(open, 'the step in the build-order band', (element) => element.id === 'band-step');
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
  await clickElement(open, bandStep.id);
  await inspect.getByRole('combobox', { name: 'Step', exact: true }).selectOption({ label: 'Not a step' });
  await elementWhere(open, 'the unticked band step keeps its place as a plain box', (element) => element.id === 'band-step' && element.kind === 'box' && element.step === null && pointOfBox(element) !== null);
  await verifyLinkedBoardDoc(open, worktreePath);
  await verifyBoardSplitFollowsPicks(page, panel, sessionId, boardTitle);
  await verifyBoardRowsInRail(page, panel, sessionId);
}

export async function verifyRailDrag(page: Page, sessionId: string, projectDirectory: string): Promise<string> {
  const secondSessionName = `rail-drag-second-${sessionId.slice(0, 8)}`;
  const addedReply = await controlReplyOf(page, 'add-session', { name: secondSessionName, path: projectDirectory, agent: 'claude-code', dangerouslySkipPermissions: true });
  const secondSessionId = AddedSessionReply.parse(addedReply).sessionId;
  const firstRow = page.locator(`.focus-rail .session-row[data-id="${sessionId}"]`).first();
  const secondRow = page.locator(`.focus-rail .session-row[data-id="${secondSessionId}"]`).first();
  await secondRow.waitFor();
  const boardTitle = `Rail drag plan ${sessionId.slice(0, 8)}`;
  await createBoardOverControl(page, boardTitle);
  await page.locator('.focus-rail .session-row[data-board-id]', { hasText: boardTitle }).dragTo(firstRow);
  await waitForSplitBoardTitle(page, sessionId, boardTitle);
  await firstRow.locator('[data-member="board"]').dragTo(secondRow);
  await waitForSplitBoardTitle(page, secondSessionId, boardTitle);
  await waitForSplitBoardTitle(page, sessionId, null);
  const railOrder = () => page.locator('.focus-rail .session-row[data-id]').evaluateAll((rows, ids) => rows.map((row) => row.getAttribute('data-id')).filter((id) => id !== null && ids.includes(id)), [sessionId, secondSessionId]);
  assert.deepEqual(await railOrder(), [sessionId, secondSessionId], 'the added session starts below the case session');
  await secondRow.locator('[data-member="terminal"]').dragTo(firstRow, { targetPosition: { x: 20, y: 2 } });
  await pollFor('the dragged session moves above the case session', BOARD_TIMEOUT_MS, async () => {
    const order = await railOrder();
    return order[0] === secondSessionId ? order : null;
  });
  return 'the split board line drags its board to another session, and the session row still reorders';
}

async function splitBoardTitleOf(page: Page, sessionId: string): Promise<string | null> {
  const splitTitle = page.locator(`.focus-rail .session-row[data-id="${sessionId}"][data-split] .session-row-split-board-title`);
  if (await splitTitle.count() === 0) return null;
  return splitTitle.textContent();
}

async function waitForSplitBoardTitle(page: Page, sessionId: string, boardTitle: string | null): Promise<void> {
  await pollFor(`the rail split shows ${boardTitle ?? 'no board'}`, BOARD_TIMEOUT_MS, async () => (await splitBoardTitleOf(page, sessionId) === boardTitle ? true : null));
}

async function verifyBoardRowsInRail(page: Page, panel: Locator, sessionId: string): Promise<void> {
  const laterTitle = `Later plan ${sessionId.slice(0, 8)}`;
  const secondTitle = `Second plan ${sessionId.slice(0, 8)}`;
  assert.equal(await page.locator('.rail-boards-details').count(), 0, 'the rail has no separate Boards section');
  const laterRow = page.locator('.focus-rail .session-row[data-board-id]', { hasText: laterTitle });
  await laterRow.waitFor();
  assert.equal(await laterRow.locator('.session-row-label').textContent(), 'BOARD', 'a board outside a split shows a BOARD row');
  assert.equal(await laterRow.locator('.session-row-task').isHidden(), true, 'a board row with no connected session shows no session line');
  assert.equal(await page.locator('.focus-rail .session-row[data-board-id]', { hasText: secondTitle }).count(), 0, 'a board in a split has no row of its own');
  await laterRow.click();
  await openBoardTitle(panel, laterTitle).waitFor();
  await page.locator('#focus-pane-terminal').waitFor({ state: 'hidden' });
  await verifyRailArrowsReachBoardRows(page, laterTitle);
  await laterRow.and(page.locator('.focused')).waitFor();
  const sessionRow = page.locator(`.focus-rail .session-row[data-id="${sessionId}"]`).first();
  await sessionRow.locator('.session-row-glyph').click();
  await page.locator('#focus-pane-terminal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.focus-rail .session-row[data-board-id].focused').count(), 0, 'picking a session leaves the board row');
  await laterRow.dragTo(sessionRow);
  await waitForSplitBoardTitle(page, sessionId, laterTitle);
  await openBoardTitle(panel, laterTitle).waitFor();
  assert.notEqual(await page.locator('.pane-layout').getAttribute('data-direction'), 'single', 'dropping a board row on a session splits it');
  await page.locator('.pane-group[data-pane="board"] > .pane-header').dragTo(sessionRow);
  await waitForSplitBoardTitle(page, sessionId, null);
  await page.locator('#focus-pane-board').waitFor({ state: 'hidden' });
  await laterRow.waitFor({ state: 'detached' });
  assert.equal(await sessionRow.locator(`.session-board-chip[aria-label="Open board ${laterTitle}"]`).count(), 1, 'the board dropped back shows once, as a link under the session it stays connected to, with no board row of its own');
  await page.keyboard.press(BOARD_SPLIT_KEY);
  await pollFor('Alt B opens a connected board beside the session', BOARD_TIMEOUT_MS, () => splitBoardTitleOf(page, sessionId));
  await page.locator('#focus-pane-board').waitFor({ state: 'visible' });
  await sessionRow.locator('.session-row-split-board').click();
  await page.waitForFunction((id) => document.querySelector(`.focus-rail .session-row[data-id="${id}"]`)?.getAttribute('data-active-pane') === 'board', sessionId);
  await page.keyboard.press(BOARD_SPLIT_KEY);
  await page.waitForFunction(() => document.activeElement?.closest('#focus-pane-terminal') != null);
  await waitForSplitBoardTitle(page, sessionId, null);
  await page.keyboard.press(BOARD_SPLIT_KEY);
  await pollFor('Alt B from the terminal reopens the board', BOARD_TIMEOUT_MS, () => splitBoardTitleOf(page, sessionId));
}

async function verifyBoardSplitFollowsPicks(page: Page, panel: Locator, sessionId: string, shownBoardTitle: string): Promise<void> {
  const secondTitle = `Second plan ${sessionId.slice(0, 8)}`;
  const secondBoardId = await createBoardOverControl(page, secondTitle);
  await controlReplyOf(page, 'whiteboard-connect', { boardId: secondBoardId, sessionId });
  const unrelatedTitle = `Unrelated plan ${sessionId.slice(0, 8)}`;
  await createBoardOverControl(page, unrelatedTitle);
  assert.equal(await splitBoardTitleOf(page, sessionId), shownBoardTitle, 'a second board connecting leaves the open split alone');
  await openBoardMenuItem(page, panel, 'Delete board');
  await page.getByRole('button', { name: 'Delete board', exact: true }).click();
  await page.locator('#focus-pane-board').waitFor({ state: 'hidden' });
  await waitForSplitBoardTitle(page, sessionId, null);
  await page.keyboard.press(BOARD_SPLIT_KEY);
  await openBoardTitle(panel, secondTitle).waitFor();
  await waitForSplitBoardTitle(page, sessionId, secondTitle);
  await page.locator('.focus-rail .session-row[data-board-id]', { hasText: unrelatedTitle }).dragTo(page.locator(`.focus-rail .session-row[data-id="${sessionId}"]`).first());
  await openBoardTitle(panel, unrelatedTitle).waitFor();
  await waitForSplitBoardTitle(page, sessionId, unrelatedTitle);
  const laterTitle = `Later plan ${sessionId.slice(0, 8)}`;
  await createBoardOverControl(page, laterTitle);
  await page.locator('.focus-rail .session-row[data-board-id]', { hasText: laterTitle }).waitFor();
  assert.equal(await openBoardTitle(panel, unrelatedTitle).count(), 1, 'a board the operator picked stays open when the board list changes');
  await page.keyboard.press(BOARD_SPLIT_KEY);
  await page.locator('#focus-pane-board').waitFor({ state: 'hidden' });
  await waitForSplitBoardTitle(page, sessionId, null);
  await page.keyboard.press(BOARD_SPLIT_KEY);
  await openBoardTitle(panel, unrelatedTitle).waitFor();
  await waitForSplitBoardTitle(page, sessionId, unrelatedTitle);
}

async function verifyRailArrowsReachBoardRows(page: Page, boardTitle: string): Promise<void> {
  const boardRow = page.locator('.focus-rail button.session-row[data-board-id]', { hasText: boardTitle });
  const boardId = await boardRow.getAttribute('data-board-id');
  await page.locator('.focus-rail button.session-row[data-id]').first().focus();
  const railRowCount = await page.locator('.focus-rail button.session-row').count();
  const reachedBoardIds: string[] = [];
  for (let press = 0; press < railRowCount; press += 1) {
    await page.keyboard.press('ArrowDown');
    const focusedBoardId = await page.evaluate(() => document.activeElement instanceof HTMLElement ? document.activeElement.dataset.boardId ?? null : null);
    if (focusedBoardId) reachedBoardIds.push(focusedBoardId);
  }
  assert.ok(boardId && reachedBoardIds.includes(boardId), 'rail arrows reach board rows under their project');
}

async function verifyBoardToolsInBoardPane(panel: Locator, boardTitle: string): Promise<void> {
  await openBoardTitle(panel, boardTitle).waitFor();
  const boardPane = panel.locator('#focus-pane-board');
  assert.equal(await boardPane.locator('.wb-top-left').isVisible(), true, 'the board tools sit inside the Board pane');
  assert.equal(await panel.locator('.pane-strip .wb-top-left').count(), 0, 'the board title bar carries no board tools');
  assert.equal(await boardPane.locator('.wb-presence .wb-presence-pill:not(.wb-presence-count)').count(), 0, 'the board names no pill for the only connected session, the one centered beside it');
}

const SCALE_BOARD_ELEMENTS = 20000;
const SCALE_BOARD_TITLE = 'Large board';
const SCALE_HELD_FRAME_SAMPLES = 30;
const SCALE_HELD_UPDATE_TITLE = 'Changed while dragging';
const SCALE_FIRST_DRAW_BUDGET_MS = 1500;
const SCALE_FRAME_BUDGET_MS = 100;
const SCALE_DRAGGED_BOX_COUNT = 8;
const SCALE_DRAG_OFFSET = { x: 120, y: 0 };
const SCALE_DRAG_ZOOM = 0.55;
const SCALE_MAX_ZOOM_IN_NOTCHES = 80;
const SCALE_PUT_BYTES_SHARE = 0.9;
const SCALE_SAVE_TIMEOUT_MS = 30000;
const STACKED_BOX_EVERY = 10;

function scaleBoardPuts(): Op[][] {
  const board = benchmarkBoard(Math.min(SCALE_BOARD_ELEMENTS, WHITEBOARD_LIMITS.elements));
  const puts: Op[][] = [[]];
  let putBytes = 0;
  for (const element of board.elements.values()) {
    const op: Op = { op: 'add', element };
    const opBytes = JSON.stringify(op).length + 1;
    const current = puts[puts.length - 1] ?? [];
    const isFull = current.length >= WHITEBOARD_LIMITS.opsPerPut || putBytes + opBytes > WHITEBOARD_LIMITS.putBytes * SCALE_PUT_BYTES_SHARE;
    if (isFull) {
      puts.push([op]);
      putBytes = opBytes;
      continue;
    }
    current.push(op);
    putBytes += opBytes;
  }
  return puts;
}

function placesOf(board: Board, boxIds: readonly string[]): Record<string, string> {
  return Object.fromEntries(boxIds.map((boxId) => {
    const element = board.elements.get(boxId);
    const point = element?.kind === 'box' ? pointOfBox(element) : null;
    return [boxId, point ? `${point.x},${point.y}` : ''];
  }));
}

async function countDashboardBoardFetches(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counter = { boardFetches: 0 };
    Object.assign(window, { harnessBoardFetches: counter });
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function sendCounted(this: WebSocket, frame: Parameters<WebSocket['send']>[0]): void {
      const message: unknown = typeof frame === 'string' ? JSON.parse(frame) : null;
      const isDashboardFetch = typeof message === 'object' && message !== null && 'type' in message && message.type === 'whiteboard-get'
        && !('requestId' in message && typeof message.requestId === 'string' && message.requestId.startsWith('harness-'));
      if (isDashboardFetch) counter.boardFetches += 1;
      send.call(this, frame);
    };
  });
}

async function dashboardBoardFetchesOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const counter: unknown = Reflect.get(window, 'harnessBoardFetches');
    return typeof counter === 'object' && counter !== null && 'boardFetches' in counter && typeof counter.boardFetches === 'number' ? counter.boardFetches : -1;
  });
}

async function sceneBuildsOf(panel: Locator): Promise<number> {
  const sceneBuilds = await panel.locator('.wb-gl').evaluate((canvas) => (canvas instanceof HTMLElement ? canvas.dataset.sceneBuilds : undefined));
  assert.ok(sceneBuilds, 'the board renderer counts its scene builds on its canvas');
  return Number(sceneBuilds);
}

async function startFrameRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const recorder = { gapsMs: [] as number[], isRecording: true };
    Object.assign(window, { harnessFrames: recorder });
    let previousAt = performance.now();
    const onFrame = (at: number): void => {
      if (!recorder.isRecording) return;
      recorder.gapsMs.push(at - previousAt);
      previousAt = at;
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  });
}

async function stopFrameRecorder(page: Page): Promise<{ maxMs: number; p50Ms: number; frames: number }> {
  const gapsMs = await page.evaluate(() => {
    const holder: unknown = Reflect.get(window, 'harnessFrames');
    if (typeof holder !== 'object' || holder === null || !('gapsMs' in holder) || !Array.isArray(holder.gapsMs)) return [];
    Reflect.set(holder, 'isRecording', false);
    return holder.gapsMs.filter((gap): gap is number => typeof gap === 'number');
  });
  const sorted = [...gapsMs].sort((first, second) => first - second);
  return { maxMs: Math.round(sorted.at(-1) ?? 0), p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), frames: sorted.length };
}

async function visibleAtBoxRects(open: OpenBoard, board: Board, count: number): Promise<Map<string, ScreenRect>> {
  const canvasBox = await open.panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  const camera = await cameraOf(open);
  const inner = { left: canvasBox.x + 8, top: canvasBox.y + 8, right: canvasBox.x + canvasBox.width - 8, bottom: canvasBox.y + canvasBox.height - 8 };
  const picked = new Map<string, ScreenRect>();
  for (const laidOut of layoutBoard(board).elements) {
    if (laidOut.kind !== 'box' || Number(laidOut.id.slice(1)) % STACKED_BOX_EVERY === 0) continue;
    const rect = screenRectOn(camera, laidOut);
    const isInside = rect.x > inner.left && rect.y > inner.top && rect.x + rect.width < inner.right && rect.y + rect.height < inner.bottom;
    if (isInside) picked.set(laidOut.id, rect);
    if (picked.size === count) break;
  }
  return picked;
}

async function panToAtGrid(open: OpenBoard, board: Board): Promise<Map<string, ScreenRect>> {
  const { page, panel } = open;
  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  const start = { x: canvasBox.x + canvasBox.width * 0.8, y: canvasBox.y + canvasBox.height * 0.5 };
  const camera = await cameraOf(open);
  const boxesOnScreen = layoutBoard(board).elements.filter((laidOut) => laidOut.kind === 'box').map((laidOut) => centerOf(screenRectOn(camera, laidOut))).filter((center) => center.x > canvasBox.x && center.y > canvasBox.y && center.x < canvasBox.x + canvasBox.width && center.y < canvasBox.y + canvasBox.height);
  const zoomAnchor = boxesOnScreen[Math.floor(boxesOnScreen.length / 2)] ?? start;
  await page.mouse.move(zoomAnchor.x, zoomAnchor.y);
  await page.keyboard.down('Control');
  for (let notch = 0; notch < SCALE_MAX_ZOOM_IN_NOTCHES && (await cameraOf(open)).scale < SCALE_DRAG_ZOOM; notch += 1) await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => Number(document.querySelector<HTMLCanvasElement>('#focus-center canvas[data-drawn-elements]')?.dataset.drawnElements ?? 0) > 0, null, { timeout: 60000 });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const visible = await visibleAtBoxRects(open, board, SCALE_DRAGGED_BOX_COUNT);
    if (visible.size === SCALE_DRAGGED_BOX_COUNT) return visible;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(start.x - canvasBox.width * 0.4, start.y - canvasBox.height * 0.25, { steps: 10 });
    await page.mouse.up({ button: 'right' });
  }
  return visibleAtBoxRects(open, board, SCALE_DRAGGED_BOX_COUNT);
}

export async function verifyBoardScale(page: Page, sessionId: string): Promise<string> {
  await page.locator('#loading-screen').waitFor({ state: 'hidden' });
  const boardId = await createBoardOverControl(page, SCALE_BOARD_TITLE);
  const fillStartedAt = Date.now();
  for (const ops of scaleBoardPuts()) await controlReplyOf(page, 'whiteboard-op', { boardId, ops });
  const fillMs = Date.now() - fillStartedAt;
  await controlReplyOf(page, 'whiteboard-connect', { boardId, sessionId });
  await countDashboardBoardFetches(page);
  const openStartedAt = Date.now();
  const panel = await showBoardInFocus(page, sessionId, SCALE_BOARD_TITLE);
  const open: OpenBoard = { page, panel, boardId };
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#focus-center canvas[data-drawn-elements]');
    return Number(canvas?.dataset.drawnElements ?? 0) + Number(canvas?.dataset.drawnBlocks ?? 0) > 0;
  }, null, { timeout: 60000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const firstDrawMs = Date.now() - openStartedAt;

  const canvasBox = await panel.locator('.wb-canvas').boundingBox();
  assert.ok(canvasBox);
  await panel.getByRole('button', { name: 'Fit', exact: true }).click();
  const fittedBoard = screenRectOn(await cameraOf(open), layoutBoard(await shownBoardOf(open)).bounds);
  const isWholeBoardInView = fittedBoard.x >= canvasBox.x - 1 && fittedBoard.y >= canvasBox.y - 1 && fittedBoard.x + fittedBoard.width <= canvasBox.x + canvasBox.width + 1 && fittedBoard.y + fittedBoard.height <= canvasBox.y + canvasBox.height + 1;
  assert.ok(isWholeBoardInView, `Fit brings the whole large board into view, board ${JSON.stringify(fittedBoard)} canvas ${JSON.stringify(canvasBox)}`);
  await startFrameRecorder(page);
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.3, canvasBox.y + canvasBox.height * 0.4, { steps: 30 });
  await page.mouse.up({ button: 'right' });
  const pan = await stopFrameRecorder(page);

  const before = await shownBoardOf(open);
  const draggedRects = await panToAtGrid(open, before);
  const draggedBoxIds = [...draggedRects.keys()];
  assert.equal(draggedBoxIds.length, SCALE_DRAGGED_BOX_COUNT, `found ${SCALE_DRAGGED_BOX_COUNT} boxes to drag on screen`);
  for (const [index, rect] of [...draggedRects.values()].entries()) {
    const center = centerOf(rect);
    if (index > 0) await page.keyboard.down('Shift');
    await page.mouse.click(center.x, center.y);
    if (index > 0) await page.keyboard.up('Shift');
  }
  const placesBefore = placesOf(before, draggedBoxIds);
  const untouchedBoxId = [...before.elements.keys()].find((elementId) => before.elements.get(elementId)?.kind === 'box' && !draggedBoxIds.includes(elementId)) ?? '';
  const grabAt = centerOf(draggedRects.get(draggedBoxIds[0] ?? '') ?? { x: 0, y: 0, width: 0, height: 0 });
  await startFrameRecorder(page);
  await page.mouse.move(grabAt.x, grabAt.y);
  await page.mouse.down();
  const sceneBuildsAtGrab = await sceneBuildsOf(panel);
  await page.mouse.move(grabAt.x + SCALE_DRAG_OFFSET.x, grabAt.y + SCALE_DRAG_OFFSET.y, { steps: 30 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const drag = await stopFrameRecorder(page);
  assert.equal(await sceneBuildsOf(panel), sceneBuildsAtGrab, 'a drag frame moves only the dragged boxes and their wires, never rebuilding the board scene');
  const versionBeforeUpdate = (await boardOf(open)).version;
  await controlReplyOf(page, 'whiteboard-op', { boardId, ops: [{ op: 'set', id: untouchedBoxId, fields: { title: SCALE_HELD_UPDATE_TITLE } }] });
  await panel.locator(`.wb-board-meta[data-board-version="${versionBeforeUpdate + 1}"]`).waitFor({ timeout: SCALE_SAVE_TIMEOUT_MS });
  for (let step = 0; step < SCALE_HELD_FRAME_SAMPLES; step += 1) {
    await page.mouse.move(grabAt.x + SCALE_DRAG_OFFSET.x + (step % 2), grabAt.y + SCALE_DRAG_OFFSET.y);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await page.mouse.move(grabAt.x + SCALE_DRAG_OFFSET.x, grabAt.y + SCALE_DRAG_OFFSET.y);
  const dropStartedAt = Date.now();
  await page.mouse.up();
  const camera = await cameraOf(open);
  const droppedDeltaX = Math.round(SCALE_DRAG_OFFSET.x / camera.scale);
  const saved = await pollFor('the drop saves every dragged box', SCALE_SAVE_TIMEOUT_MS, async () => {
    const after = await boardOf(open);
    const placesAfter = placesOf(after, draggedBoxIds);
    return after.version > versionBeforeUpdate + 1 && draggedBoxIds.every((boxId) => placesAfter[boxId] !== placesBefore[boxId]) ? after : null;
  });
  const saveMs = Date.now() - dropStartedAt;
  for (const boxId of draggedBoxIds) {
    const beforeBox = before.elements.get(boxId);
    const savedBox = saved.elements.get(boxId);
    const beforePoint = beforeBox?.kind === 'box' ? pointOfBox(beforeBox) : null;
    const savedPoint = savedBox?.kind === 'box' ? pointOfBox(savedBox) : null;
    assert.ok(beforePoint && savedPoint);
    assert.ok(Math.abs(savedPoint.x - beforePoint.x - droppedDeltaX) <= 2, `a board update during a drag keeps ${boxId} under the pointer, it moved ${savedPoint.x - beforePoint.x} of ${droppedDeltaX}`);
  }

  const undoStartedAt = Date.now();
  await page.keyboard.press('Control+z');
  await pollFor('one undo restores every dragged box', SCALE_SAVE_TIMEOUT_MS, async () => {
    const placesRestored = placesOf(await boardOf(open), draggedBoxIds);
    return draggedBoxIds.every((boxId) => placesRestored[boxId] === placesBefore[boxId]) ? true : null;
  });
  const undoMs = Date.now() - undoStartedAt;
  assert.equal(await dashboardBoardFetchesOf(page), 0, 'the dashboard opens, drags and undoes from tiles without fetching the whole board');

  const elementCount = before.elements.size;
  const measured = `${elementCount} elements: fill ${fillMs} ms, first draw ${firstDrawMs} ms, pan max ${pan.maxMs} ms p50 ${pan.p50Ms} ms over ${pan.frames} frames, drag max ${drag.maxMs} ms p50 ${drag.p50Ms} ms over ${drag.frames} frames, save ${saveMs} ms, undo ${undoMs} ms`;
  console.log(`board-scale ${measured}`);
  assert.ok(firstDrawMs <= SCALE_FIRST_DRAW_BUDGET_MS, `the board first draws within ${SCALE_FIRST_DRAW_BUDGET_MS} ms; ${measured}`);
  assert.ok(pan.maxMs <= SCALE_FRAME_BUDGET_MS, `panning keeps every frame within ${SCALE_FRAME_BUDGET_MS} ms; ${measured}`);
  assert.ok(drag.maxMs <= SCALE_FRAME_BUDGET_MS, `dragging keeps every frame within ${SCALE_FRAME_BUDGET_MS} ms; ${measured}`);
  return measured;
}

import { z } from 'zod';
import { DEVICE_FITS, DEVICE_NAMES } from '../whiteboard-devices.ts';
import { ICON_NAMES } from '../whiteboard-icons.ts';
import { BOX_SHAPES, SHAPE_TRAITS } from '../whiteboard-shapes.ts';
import { elementTableOf, isElementTable } from '../whiteboard-element-table.ts';
import type { ElementTable } from '../whiteboard-element-table.ts';

export const WHITEBOARD_LIMITS = Object.freeze({
  elements: 1_000_000, opsPerPut: 5000, putBytes: 1_728_576, title: 80, line: 120, linesPerBox: 12, noteText: 400, logEntries: 2000, layoutWarnings: 20, readPage: 150, readPageChars: 32_000, outlineClusters: 40, queryText: 200, boxWidthMin: 160, boxWidthMax: 960, boxHeightMax: 2400, dialsPerPage: 16, dialChoices: 12, strokePoints: 1000, strokes: 500, strokeWidthMax: 24,
  wireLabel: 40, lineKey: 40, caption: 400, ref: 200, refsPerElement: 8, legendEntries: 12, legendLabel: 40,
});


const ElementId = z.string({ error: 'an id must be a string' })
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit' })
  .meta({ id: 'ElementId' });

const Title = z.string().max(WHITEBOARD_LIMITS.title, { error: `a title is at most ${WHITEBOARD_LIMITS.title} characters` });

export const AnchorRef = z.string().min(1).max(WHITEBOARD_LIMITS.ref, { error: `a ref is at most ${WHITEBOARD_LIMITS.ref} characters` })
  .regex(/^[^#\s]+(#L[1-9]\d*(-L[1-9]\d*)?)?$/, { error: 'a ref is path, path#L12 or path#L12-L30' })
  .meta({ id: 'AnchorRef', description: 'a code location: path, path#L12 or path#L12-L30' });

export const IconName = z.enum(ICON_NAMES).meta({ id: 'IconName', description: 'a catalog icon, drawn in the text color' });
export const DeviceName = z.enum(DEVICE_NAMES).meta({ id: 'DeviceName', description: 'a catalog device drawn around the box media' });
const DeviceFit = z.enum(DEVICE_FITS).default('fill').describe('fill covers the screen and crops; fit shows all of the media, letterboxed');

export const LINE_STYLES = ['text', 'code', 'item', 'kv'] as const;

const AnchorRefs = z.array(AnchorRef).max(WHITEBOARD_LIMITS.refsPerElement, { error: `an element carries at most ${WHITEBOARD_LIMITS.refsPerElement} refs` }).default([]);

export const BoxLine = z.object({
  text: z.string().max(WHITEBOARD_LIMITS.line, { error: `a box line is at most ${WHITEBOARD_LIMITS.line} characters` }),
  muted: z.boolean().default(false),
  style: z.enum(LINE_STYLES).default('text'),
  key: z.string().max(WHITEBOARD_LIMITS.lineKey, { error: `a line key is at most ${WHITEBOARD_LIMITS.lineKey} characters` }).nullable().default(null),
}).strict().refine((line) => line.style !== 'kv' || Boolean(line.key), { error: 'a kv line needs a key' }).meta({ id: 'BoxLine' });

const Point = z.object({ x: z.number(), y: z.number() }).strict().meta({ id: 'Point' });

export const BOX_CHANGES = ['none', 'added', 'removed', 'relabeled'] as const;
export const WIRE_TONES = ['plain', 'fail', 'join'] as const;
export const NOTE_TONES = ['yellow', 'pink', 'green', 'blue', 'violet'] as const;
export type NoteTone = (typeof NOTE_TONES)[number];
export const NOTE_TONE_HEX: Readonly<Record<NoteTone, string>> = { yellow: '#f5d565', pink: '#f28bb6', green: '#7fd49a', blue: '#7cb4f2', violet: '#b49cf5' };

export const STEP_STATUSES = ['planned', 'building', 'landed'] as const;

export const SIDES = ['left', 'right', 'top', 'bottom'] as const;
const Side = z.enum(SIDES).meta({ id: 'Side' });

export const Near = z.object({
  of: ElementId,
  side: Side,
  gap: z.number().int().min(0).default(60),
}).strict().meta({ id: 'Near' });

export const WHITEBOARD_ASSET_ROUTE = '/whiteboards/assets';
export const WHITEBOARD_PICTURE_ROUTE = '/whiteboards/pictures';
export const WHITEBOARD_PAGE_ROUTE = '/whiteboards/pages';
export const BOARD_PAGE_ENTRY_PATH = 'index.html';
export const BOARD_PAGE_ESCAPE_MESSAGE = 'glimmervoid-board-page-escape';
export const BOARD_PAGE_PARAMS_MESSAGE = 'glimmervoid-params';
export const BOARD_PAGE_TUNED_QUERY = 'tuned=1';
export const BOARD_PAGE_THEME_MESSAGE = 'glimmervoid-theme';
export const BOARD_PAGE_GESTURE_MESSAGE = 'glimmervoid-board-page-gesture';
export const BOARD_PAGE_ZOOMED_MESSAGE = 'glimmervoid-board-page-zoomed';

const PagePixels = z.number().finite();
export const BoardPageGesture = z.discriminatedUnion('gesture', [
  z.object({ type: z.literal(BOARD_PAGE_GESTURE_MESSAGE), gesture: z.literal('pinch'), centerX: PagePixels, centerY: PagePixels, scaleFactor: z.number().finite().positive() }).strict(),
  z.object({ type: z.literal(BOARD_PAGE_GESTURE_MESSAGE), gesture: z.literal('pan'), deltaX: PagePixels, deltaY: PagePixels }).strict(),
  z.object({ type: z.literal(BOARD_PAGE_GESTURE_MESSAGE), gesture: z.literal('wheel'), centerX: PagePixels, centerY: PagePixels, deltaX: PagePixels, deltaY: PagePixels, isZoom: z.boolean() }).strict(),
  z.object({ type: z.literal(BOARD_PAGE_GESTURE_MESSAGE), gesture: z.literal('doubleTap'), centerX: PagePixels, centerY: PagePixels }).strict(),
]);
export type BoardPageGesture = z.infer<typeof BoardPageGesture>;

const AssetId = z.string().regex(/^[0-9a-f]{64}$/, { error: 'an asset is the 64 hex character id whiteboard attach returned' }).meta({ id: 'AssetId' });

const BOARD_MEDIA_KINDS = ['image', 'video', 'page', 'doc'] as const;
const BOARD_MEDIA_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'text/html', 'text/markdown'] as const;
export const BOARD_MEDIA_MAX_EDGE_PX = 16384;
export const BOARD_DOC_CAP_BYTES = 256 * 1024;

const DialId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, { error: 'a dial id is 1 to 40 letters, digits, dashes or underscores' });
const DialLabel = z.string().min(1, { error: 'a dial needs a label' }).max(WHITEBOARD_LIMITS.title, { error: `a dial label is at most ${WHITEBOARD_LIMITS.title} characters` });
const DialColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'a color dial value is #rrggbb' });
const DialChoice = z.string().min(1).max(WHITEBOARD_LIMITS.title);

export const Dial = z.discriminatedUnion('kind', [
  z.object({ id: DialId, label: DialLabel, kind: z.literal('range'), min: z.number(), max: z.number(), step: z.number().positive().default(1), default: z.number() }).strict()
    .refine((dial) => dial.min < dial.max && dial.default >= dial.min && dial.default <= dial.max, { error: 'a range dial needs min below max and its default between them' }),
  z.object({ id: DialId, label: DialLabel, kind: z.literal('toggle'), default: z.boolean().default(false) }).strict(),
  z.object({ id: DialId, label: DialLabel, kind: z.literal('color'), default: DialColor }).strict(),
  z.object({ id: DialId, label: DialLabel, kind: z.literal('choice'), options: z.array(DialChoice).min(1).max(WHITEBOARD_LIMITS.dialChoices, { error: `a choice dial has at most ${WHITEBOARD_LIMITS.dialChoices} options` }), default: DialChoice }).strict()
    .refine((dial) => dial.options.includes(dial.default), { error: 'a choice dial default is one of its options' }),
], { error: 'a dial kind is range, toggle, color or choice' }).meta({ id: 'Dial', description: 'a control a page declares in its application/glimmervoid-params script tag' });

export const DialManifest = z.array(Dial).max(WHITEBOARD_LIMITS.dialsPerPage, { error: `a page declares at most ${WHITEBOARD_LIMITS.dialsPerPage} dials` })
  .refine((dials) => new Set(dials.map((dial) => dial.id)).size === dials.length, { error: 'each dial id is used once' });

export const DialValue = z.union([z.number(), z.boolean(), DialChoice]);
const DialParams = z.record(DialId, DialValue).default({}).describe('dial values for a page box, by dial id; a value must suit the dial its page declares');

const LINK_STATES = ['in-sync', 'file-ahead', 'card-ahead', 'diverged', 'broken'] as const;
const LinkPath = z.string().min(1, { error: 'a linked file path is not empty' }).max(4096, { error: 'a linked file path is at most 4096 characters' })
  .describe('a file path relative to the board code session worktree, with no .. segment');
export const MediaLink = z.object({
  path: LinkPath,
  syncedHash: AssetId.nullable().default(null).describe('the sha256 of the file at the last sync; leave null to take the file content on the next read'),
}).strict().meta({ id: 'MediaLink' });

export const BoxMedia = z.object({
  kind: z.enum(BOARD_MEDIA_KINDS).describe('what the media is, as attach returned it'),
  asset: AssetId,
  mime: z.enum(BOARD_MEDIA_MIMES).describe('the media type, as attach returned it'),
  width: z.number().int().min(1).max(BOARD_MEDIA_MAX_EDGE_PX).describe('the media width in pixels, as attach returned it'),
  height: z.number().int().min(1).max(BOARD_MEDIA_MAX_EDGE_PX).describe('the media height in pixels, as attach returned it'),
  alt: z.string().max(WHITEBOARD_LIMITS.line, { error: `a media alt is at most ${WHITEBOARD_LIMITS.line} characters` }).default(''),
  hasPreview: z.boolean().default(false).describe('whether attach stored a smaller preview beside the original'),
  dials: DialManifest.default([]).describe('the dials a page declares, as attach returned them'),
  link: MediaLink.nullable().default(null).describe('a doc or page linked to a file in the board code session worktree: the card follows the file when the board is read, and an operator save of a doc writes it'),
}).strict().meta({ id: 'BoxMedia' });

export const BoardMediaUploadReply = z.object({ ok: z.literal(true), media: BoxMedia }).strict();

export const Step = z.object({
  status: z.enum(STEP_STATUSES).default('planned'),
}).strict().meta({ id: 'Step' });

const PLACE_ERROR = 'a box needs a place: {"at":{"x":0,"y":0}}, {"near":{"of":"id","side":"right"}}, "aside" or "plan"';

const Place = z.union([
  z.object({ at: Point }).strict(),
  z.literal('aside'),
  z.literal('plan'),
], { error: PLACE_ERROR }).meta({ id: 'Place' });

const PlaceInput = z.union([...Place.options, z.object({ near: Near }).strict()], { error: PLACE_ERROR })
  .describe('where the box sits: {"at":point}; {"near":{of,side}} beside another box, stored as the point it lands on; "aside" stacked right of the drawing by order; "plan" the build-order band, plan steps only');

const BoxWidth = z.number().int()
  .min(WHITEBOARD_LIMITS.boxWidthMin, { error: `a box width is ${WHITEBOARD_LIMITS.boxWidthMin} to ${WHITEBOARD_LIMITS.boxWidthMax}` })
  .max(WHITEBOARD_LIMITS.boxWidthMax, { error: `a box width is ${WHITEBOARD_LIMITS.boxWidthMin} to ${WHITEBOARD_LIMITS.boxWidthMax}` });
const BoxHeight = z.number().int()
  .min(1, { error: `a box height is 1 to ${WHITEBOARD_LIMITS.boxHeightMax}` })
  .max(WHITEBOARD_LIMITS.boxHeightMax, { error: `a box height is 1 to ${WHITEBOARD_LIMITS.boxHeightMax}` });

const boxFields = {
  kind: z.literal('box'),
  id: ElementId,
  shape: z.enum(BOX_SHAPES, { error: `a box shape is ${BOX_SHAPES.join(', ')}` }).default('box').describe('decision draws a diamond; note a note card; icon its icon large, with no lines or media; device a catalog device around its media, with no lines'),
  title: Title.min(1, { error: 'a box needs a title' }),
  icon: IconName.nullable().default(null).describe('drawn before the title; the big glyph of an icon box'),
  place: Place,
  order: z.number().int().default(0).describe('position in the aside stack, lowest first'),
  width: BoxWidth.nullable().default(null).describe(`null is the 220 default`),
  height: BoxHeight.nullable().default(null).describe('the least height; content can still grow the box'),
  borderless: z.boolean().nullable().default(null).describe('true draws no card fill or outline; null is the shape default, bare for icon and device; a note always draws its card'),
  tone: z.enum(NOTE_TONES).nullable().default(null).describe('a note color'),
  device: DeviceName.nullable().default(null),
  fit: DeviceFit,
  lines: z.array(BoxLine).max(WHITEBOARD_LIMITS.linesPerBox, { error: `a box holds at most ${WHITEBOARD_LIMITS.linesPerBox} lines` }).default([]),
  media: BoxMedia.nullable().default(null).describe('from whiteboard attach'),
  params: DialParams,
  refs: AnchorRefs,
  change: z.enum(BOX_CHANGES).default('none').describe('marks the box in a diff'),
  was: Title.nullable().default(null).describe('the old title, required when change is relabeled'),
  step: Step.nullable().default(null).describe('makes the box a plan step; a wire from one step to another means the second is built after the first'),
  author: z.string().min(1).max(WHITEBOARD_LIMITS.title).nullable().default(null).describe('who wrote a note; the server sets it'),
};

type ShapeCheckedBox = Pick<z.infer<z.ZodObject<typeof boxFields>>, 'id' | 'shape' | 'icon' | 'device' | 'fit' | 'tone' | 'borderless' | 'lines' | 'media' | 'step' | 'author'> & { place: unknown };

function boxShapeProblemsOf(box: ShapeCheckedBox): string[] {
  const traits = SHAPE_TRAITS[box.shape];
  const problems = [
    traits.needsIcon && box.icon === null && `an ${box.shape} box needs an icon`,
    traits.needsDevice && box.device === null && 'a device box needs a device',
    !traits.needsDevice && box.device !== null && 'only a device box takes device',
    !traits.needsDevice && box.fit !== 'fill' && 'only a device box takes fit',
    !traits.takesTone && box.tone !== null && 'only a note takes tone',
    box.shape === 'note' && box.borderless !== null && 'a note always draws its card, so only other shapes take borderless',
    !traits.holdsLines && box.lines.length > 0 && `a ${box.shape} box holds no lines, so set shape to box first`,
    !traits.holdsMedia && box.media !== null && `a ${box.shape} box holds no media, so set shape to box first`,
    box.place === 'plan' && box.step === null && 'place plan is for plan steps',
    box.shape !== 'note' && box.author !== null && 'only a note has an author',
  ];
  return problems.filter((problem) => typeof problem === 'string');
}

function addBoxShapeProblems(box: ShapeCheckedBox, context: z.RefinementCtx): void {
  for (const problem of boxShapeProblemsOf(box)) context.addIssue({ code: 'custom', message: `box ${box.id}: ${problem}` });
}

export const Box = z.object(boxFields).strict().superRefine(addBoxShapeProblems);
export const BoxInput = z.object({ ...boxFields, place: PlaceInput }).strict().superRefine(addBoxShapeProblems);

export function pointOfBox(box: Pick<Box, 'place'>): Point | null {
  return typeof box.place === 'object' ? box.place.at : null;
}

export function dialValuesOfBox(box: Pick<Box, 'media' | 'params'>): Record<string, DialValue> {
  const { media, params } = box;
  if (media?.kind !== 'page') return {};
  return Object.fromEntries(media.dials.map((dial) => [dial.id, Object.hasOwn(params, dial.id) ? params[dial.id] ?? dial.default : dial.default]));
}

function isDialValueSuited(dial: Dial, value: DialValue): boolean {
  switch (dial.kind) {
    case 'range': return typeof value === 'number' && value >= dial.min && value <= dial.max;
    case 'toggle': return typeof value === 'boolean';
    case 'color': return typeof value === 'string' && DialColor.safeParse(value).success;
    case 'choice': return typeof value === 'string' && dial.options.includes(value);
  }
}

export function dialParamsProblemOf(box: Pick<Box, 'id' | 'media' | 'params'>): string | null {
  const dialsById = new Map((box.media?.dials ?? []).map((dial) => [dial.id, dial]));
  for (const [dialId, value] of Object.entries(box.params)) {
    const dial = dialsById.get(dialId);
    if (!dial) return `box ${box.id} sets dial ${dialId}, which its page does not declare`;
    if (!isDialValueSuited(dial, value)) return `box ${box.id} sets dial ${dialId} to ${JSON.stringify(value)}, which does not suit a ${dial.kind} dial`;
  }
  return null;
}

export const Frame = z.object({
  kind: z.literal('frame'),
  id: ElementId,
  title: Title,
  contains: z.array(ElementId).min(1, { error: 'a frame contains at least one box' }).describe('the box ids it encloses'),
  collapsed: z.boolean().default(false).describe('a stack: draws as one card showing its first box, hides the rest, and ends their wires at the card; a box sits in at most one collapsed frame'),
}).strict();

export const Wire = z.object({
  kind: z.literal('wire'),
  id: ElementId,
  from: ElementId.describe('the element id it starts at'),
  to: ElementId.describe('the element id it ends at'),
  dashed: z.boolean().default(false),
  tone: z.enum(WIRE_TONES).default('plain'),
  label: z.string().max(WHITEBOARD_LIMITS.wireLabel, { error: `a wire label is at most ${WHITEBOARD_LIMITS.wireLabel} characters` }).nullable().default(null),
  fromSide: Side.nullable().default(null),
  toSide: Side.nullable().default(null),
}).strict();

export const STROKE_TONES = ['ink', ...NOTE_TONES] as const;

export const Stroke = z.object({
  kind: z.literal('stroke'),
  id: ElementId,
  points: z.array(z.number().int()).min(4, { error: 'a stroke needs at least two points' })
    .max(WHITEBOARD_LIMITS.strokePoints * 2, { error: `a stroke has at most ${WHITEBOARD_LIMITS.strokePoints} points` })
    .refine((points) => points.length % 2 === 0, { error: 'stroke points are x, y pairs' })
    .describe('flat x, y pairs in board units'),
  width: z.number().int().min(1).max(WHITEBOARD_LIMITS.strokeWidthMax, { error: `a stroke width is 1 to ${WHITEBOARD_LIMITS.strokeWidthMax}` }).default(3),
  tone: z.enum(STROKE_TONES).default('ink'),
}).strict().describe('freehand ink the operator drew; agents read and remove strokes but never draw or change them');

export const Element = z.discriminatedUnion('kind', [Box, Frame, Wire, Stroke], { error: 'an element kind is box, frame, wire or stroke' });
export const ElementInput = z.discriminatedUnion('kind', [BoxInput, Frame, Wire, Stroke], { error: 'an element kind is box, frame, wire or stroke' });

const LegendEntries = z.array(z.object({
  tone: Wire.shape.tone,
  dashed: z.boolean().default(false),
  label: z.string().min(1, { error: 'a legend entry needs a label' }).max(WHITEBOARD_LIMITS.legendLabel, { error: `a legend label is at most ${WHITEBOARD_LIMITS.legendLabel} characters` }),
}).strict()).max(WHITEBOARD_LIMITS.legendEntries, { error: `a legend has at most ${WHITEBOARD_LIMITS.legendEntries} entries` });

const CodeSessionId = z.string().min(1).max(64);
const ProjectPath = z.string().min(1).max(4096);

export const Board = z.object({
  id: z.string().min(1).max(64),
  title: Title.min(1),
  version: z.number().int().nonnegative(),
  caption: z.string().max(WHITEBOARD_LIMITS.caption).nullable(),
  legend: LegendEntries.default([]),
  codeSessionId: CodeSessionId.nullable().default(null),
  project: ProjectPath.nullable().default(null),
  elements: z.custom<ElementTable>(isElementTable).or(z.record(ElementId, Element)
    .refine((elements) => Object.keys(elements).length <= WHITEBOARD_LIMITS.elements, { error: `a board holds at most ${WHITEBOARD_LIMITS.elements} elements` })
    .refine((elements) => Object.entries(elements).every(([id, element]) => element.id === id), { error: 'every element is stored under its own id' })
    .transform((elements) => elementTableOf(Object.values(elements)))),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();

export const BoardHead = Board.omit({ elements: true });

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), element: ElementInput }).strict(),
  z.object({ op: z.literal('set'), id: ElementId, fields: z.record(z.string(), z.unknown()).describe('the element fields to change, as in {"title":"Gateway"}') }).strict(),
  z.object({ op: z.literal('remove'), id: ElementId }).strict(),
  z.object({ op: z.literal('board'), title: Title.min(1).optional(), caption: z.string().max(WHITEBOARD_LIMITS.caption).nullable().optional(), legend: LegendEntries.optional(), codeSessionId: CodeSessionId.nullable().optional() }).strict(),
  z.object({ op: z.literal('align'), ids: z.array(ElementId).min(2).max(50).describe('the placed boxes to line up'), as: z.enum(['row', 'column']).describe('row gives every box the top of the highest and the height of the tallest; column gives the left of the leftmost and the width of the widest') }).strict(),
], { error: 'an op is add, set, remove, board or align' });

export const BoardChange = z.object({
  version: z.number().int(),
  author: z.string(),
  elementId: z.string().nullable(),
  summary: z.string(),
}).strict();

export const BoardSummary = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number().int(),
  updatedAt: z.number(),
  project: ProjectPath.nullable(),
  isArchived: z.boolean(),
  connectedSessionIds: z.array(z.string()),
  queuedBySessionId: z.record(z.string(), z.number().int()),
}).strict();

export const BoardAttachments = z.record(z.string(), z.string());

export const BoardRecord = z.object({
  board: Board,
  log: z.array(BoardChange),
  cursorBySessionId: z.record(z.string(), z.number().int()),
  createdBy: z.string().nullable().default(null),
}).strict();

const BoardRef = z.string({ error: 'the board must be a string' }).min(1, { error: 'name the board by id or title' }).max(200);

export const BoardRegion = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive({ error: 'a region width is above 0' }),
  height: z.number().finite().positive({ error: 'a region height is above 0' }),
}).strict().meta({ id: 'BoardRegion' });

const ReadCursor = z.string().max(40).regex(/^\d+\.\d+$/, { error: 'a cursor is the nextCursor a previous read returned' }).describe('the nextCursor a previous read returned, to read the next page');

const BoardQuery = z.object({
  sub: z.literal('query'),
  board: BoardRef,
  region: BoardRegion.optional(),
  ids: z.array(ElementId).min(1).max(WHITEBOARD_LIMITS.readPage, { error: `a query names at most ${WHITEBOARD_LIMITS.readPage} ids` }).optional(),
  text: z.string().trim().min(1).max(WHITEBOARD_LIMITS.queryText, { error: `query text is at most ${WHITEBOARD_LIMITS.queryText} characters` }).optional(),
  cursor: ReadCursor.optional(),
}).strict().refine((query) => [query.region, query.ids, query.text].filter((criterion) => criterion !== undefined).length === 1, { error: 'a query takes exactly one of region, ids or text' });

export const WhiteboardAgentRequest = z.discriminatedUnion('sub', [
  z.object({ sub: z.literal('new'), title: Title.min(1, { error: 'a new board needs a title' }) }).strict(),
  z.object({ sub: z.literal('list'), all: z.boolean().optional() }).strict(),
  z.object({ sub: z.literal('connect'), board: BoardRef }).strict(),
  z.object({ sub: z.literal('disconnect'), board: BoardRef }).strict(),
  z.object({ sub: z.literal('get'), board: BoardRef, peek: z.boolean().optional(), review: z.boolean().optional(), region: BoardRegion.optional(), cursor: ReadCursor.optional(), whole: z.boolean().optional() }).strict(),
  BoardQuery,
  z.object({
    sub: z.literal('put'),
    board: BoardRef,
    ops: z.array(Op).min(1, { error: 'put needs at least one op' }).max(WHITEBOARD_LIMITS.opsPerPut, { error: `one put carries at most ${WHITEBOARD_LIMITS.opsPerPut} ops` }),
  }).strict(),
  z.object({ sub: z.literal('doc'), board: BoardRef, box: ElementId }).strict(),
  z.object({ sub: z.literal('delete'), board: BoardRef }).strict(),
  z.object({ sub: z.literal('attach'), path: z.string().min(1, { error: 'attach needs the media path' }).max(4096) }).strict(),
  z.object({
    sub: z.literal('show'),
    path: z.string().min(1, { error: 'show needs the file path' }).max(4096),
    caption: z.string().max(WHITEBOARD_LIMITS.line, { error: `a show caption is at most ${WHITEBOARD_LIMITS.line} characters` }).optional(),
    link: z.boolean().optional().describe('link a Markdown or HTML card to the file, so the card follows it when the board is read and an operator save writes it'),
  }).strict(),
], { error: 'whiteboard takes new, list, connect, disconnect, get, query, put, doc, delete, attach or show' });

export const WorthALookPath = z.object({ path: z.string(), reason: z.string() }).strict();

export const LinkStateOfBox = z.object({ boxId: ElementId, state: z.enum(LINK_STATES), text: z.string() }).strict();

export const BoardReview = z.object({
  codeSessionId: z.string().nullable(),
  anchorWarnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  stepWarnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  uncoveredPaths: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  worthALook: z.array(WorthALookPath).max(WHITEBOARD_LIMITS.layoutWarnings),
  flaggedStepIds: z.array(ElementId).max(WHITEBOARD_LIMITS.elements),
  notChecked: z.string().nullable(),
  linkStates: z.array(LinkStateOfBox).max(WHITEBOARD_LIMITS.elements).default([]),
}).strict();

export const BoardOutline = z.object({
  elementCount: z.number().int(),
  countsByKind: z.record(z.string(), z.number().int()),
  bounds: BoardRegion,
  frames: z.array(z.object({ id: z.string(), title: z.string(), rect: BoardRegion }).strict()).max(WHITEBOARD_LIMITS.readPage),
  clustersOutsideFocus: z.array(z.object({ rect: BoardRegion, elementCount: z.number().int(), titles: z.array(z.string()) }).strict()).max(WHITEBOARD_LIMITS.outlineClusters),
}).strict();

const StrokeBounds = z.object({
  kind: z.literal('stroke'),
  id: ElementId,
  bounds: BoardRegion,
  pointCount: z.number().int(),
  width: z.number().int(),
  tone: z.enum(STROKE_TONES),
}).strict().describe('operator ink, read as its bounds; remove it by id');

export const ReadElement = z.union([Element, StrokeBounds]);

const ElementPage = {
  elements: z.array(ReadElement).max(WHITEBOARD_LIMITS.readPage),
  nextCursor: z.string().nullable(),
};

export const WhiteboardAgentReply = z.union([
  z.object({ ok: z.literal(true), board: BoardSummary, outline: BoardOutline, focus: BoardRegion, ...ElementPage, changes: z.array(BoardChange), review: BoardReview.optional() }).strict(),
  z.object({ ok: z.literal(true), version: z.number().int(), ...ElementPage, missingIds: z.array(z.string()) }).strict(),
  z.object({ ok: z.literal(true), board: BoardSummary, note: z.string() }).strict(),
  z.object({ ok: z.literal(true), boards: z.array(BoardSummary) }).strict(),
  z.object({ ok: z.literal(true), board: Board, changes: z.array(BoardChange), review: BoardReview.optional() }).strict(),
  z.object({ ok: z.literal(true), version: z.number().int(), warnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings).optional() }).strict(),
  z.object({ ok: z.literal(true), media: BoxMedia, note: z.string() }).strict(),
  z.object({ ok: z.literal(true), box: ElementId, text: z.string().max(BOARD_DOC_CAP_BYTES) }).strict(),
]);

function isDefaultValue(value: unknown, defaultValue: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(defaultValue);
}

const optionByTagByUnion = new WeakMap<z.core.$ZodDiscriminatedUnion, Map<unknown, z.core.$ZodType>>();

function optionByTagOf(union: z.core.$ZodDiscriminatedUnion): Map<unknown, z.core.$ZodType> {
  const known = optionByTagByUnion.get(union);
  if (known) return known;
  const { discriminator, options } = union._zod.def;
  const optionByTag = new Map<unknown, z.core.$ZodType>(options.flatMap((option) => [...(option._zod.propValues?.[discriminator] ?? [])].map((tag): [unknown, z.core.$ZodType] => [tag, option])));
  optionByTagByUnion.set(union, optionByTag);
  return optionByTag;
}

function matchingOption(union: z.core.$ZodUnion, value: unknown): z.core.$ZodType | null {
  if (union instanceof z.core.$ZodDiscriminatedUnion && typeof value === 'object' && value !== null) return optionByTagOf(union).get(Reflect.get(value, union._zod.def.discriminator)) ?? null;
  return union._zod.def.options.find((option) => z.safeParse(option, value).success) ?? null;
}

function withoutDefaults(schema: z.core.$ZodType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isElementTable(value)) return Object.fromEntries([...value.entries()].map(([id, element]) => [id, withoutDefaults(Element, element)]));
  if (schema instanceof z.core.$ZodDefault || schema instanceof z.core.$ZodNullable || schema instanceof z.core.$ZodOptional) return withoutDefaults(schema._zod.def.innerType, value);
  if (schema instanceof z.core.$ZodArray && Array.isArray(value)) return value.map((item) => withoutDefaults(schema._zod.def.element, item));
  if (schema instanceof z.core.$ZodUnion) {
    const option = matchingOption(schema, value);
    return option ? withoutDefaults(option, value) : value;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  if (schema instanceof z.core.$ZodRecord) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutDefaults(schema._zod.def.valueType, item)]));
  if (!(schema instanceof z.core.$ZodObject)) return value;
  const shape: Readonly<Record<string, z.core.$ZodType>> = schema._zod.def.shape;
  const sparseEntries = Object.entries(value).flatMap(([key, item]) => {
    const fieldSchema = shape[key];
    if (!fieldSchema) return [[key, item]];
    if (fieldSchema instanceof z.core.$ZodDefault && isDefaultValue(item, fieldSchema._zod.def.defaultValue)) return [];
    return [[key, withoutDefaults(fieldSchema, item)]];
  });
  return Object.fromEntries(sparseEntries);
}

const BOARD_MEDIA_EXTENSION_BY_MIME: Record<BoxMedia['mime'], string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'text/html': '.html', 'text/markdown': '.md',
};

export function boardMediaOriginalFilename(media: Pick<BoxMedia, 'asset' | 'mime'>): string {
  return `${media.asset}${BOARD_MEDIA_EXTENSION_BY_MIME[media.mime]}`;
}

export function boardPagePath(media: Pick<BoxMedia, 'asset'>): string {
  return `${WHITEBOARD_PAGE_ROUTE}/${media.asset}/${BOARD_PAGE_ENTRY_PATH}`;
}

export function boardMediaDrawnFilename(media: Pick<BoxMedia, 'kind' | 'asset' | 'mime' | 'hasPreview'>): string | null {
  if (media.hasPreview) return `${media.asset}.preview.webp`;
  return media.kind === 'image' ? boardMediaOriginalFilename(media) : null;
}

export function sparseElement(element: Element): unknown {
  return withoutDefaults(Element, element);
}

type SparseElement = z.input<typeof Element>;
type SparseBox = z.input<typeof Box>;

function filledLine(line: z.input<typeof BoxLine>): BoxLine {
  return { text: line.text, muted: line.muted ?? false, style: line.style ?? 'text', key: line.key ?? null };
}

function filledMedia(media: z.input<typeof BoxMedia> | null | undefined): BoxMedia | null {
  if (!media) return null;
  return { kind: media.kind, asset: media.asset, mime: media.mime, width: media.width, height: media.height, alt: media.alt ?? '', hasPreview: media.hasPreview ?? false, dials: media.dials?.length ? DialManifest.parse(media.dials) : [], link: media.link ? { path: media.link.path, syncedHash: media.link.syncedHash ?? null } : null };
}

function filledBox(box: SparseBox): Box {
  return {
    kind: 'box', id: box.id, shape: box.shape ?? 'box', title: box.title, icon: box.icon ?? null, place: box.place,
    order: box.order ?? 0, width: box.width ?? null, height: box.height ?? null,
    borderless: box.borderless ?? null, tone: box.tone ?? null, device: box.device ?? null, fit: box.fit ?? 'fill',
    lines: (box.lines ?? []).map(filledLine), media: filledMedia(box.media), params: box.params ?? {},
    refs: box.refs ?? [], change: box.change ?? 'none', was: box.was ?? null,
    step: box.step ? { status: box.step.status ?? 'planned' } : null, author: box.author ?? null,
  };
}

export function filledElement(element: SparseElement): Element {
  switch (element.kind) {
    case 'box': return filledBox(element);
    case 'frame': return { kind: 'frame', id: element.id, title: element.title, contains: element.contains, collapsed: element.collapsed ?? false };
    case 'wire': return {
      kind: 'wire', id: element.id, from: element.from, to: element.to, dashed: element.dashed ?? false, tone: element.tone ?? 'plain',
      label: element.label ?? null, fromSide: element.fromSide ?? null, toSide: element.toSide ?? null,
    };
    case 'stroke': return { kind: 'stroke', id: element.id, points: element.points, width: element.width ?? 3, tone: element.tone ?? 'ink' };
  }
}

function withSparseElements<Body extends object>(body: Body): Body | Record<string, unknown> {
  if (!('elements' in body) || !Array.isArray(body.elements)) return body;
  return { ...body, elements: body.elements.map((element: unknown) => withoutDefaults(Element, element)) };
}

export function sparseBoardReply<Body extends object>(body: Body): Body | Record<string, unknown> {
  const sparse = withSparseElements(body);
  if (!('changes' in sparse) || !('board' in sparse)) return sparse;
  const board = Board.safeParse(sparse.board);
  return board.success ? { ...sparse, board: withoutDefaults(Board, board.data) } : sparse;
}

export type Box = z.infer<typeof Box>;
export type Near = z.infer<typeof Near>;
export type Point = z.infer<typeof Point>;
export type BoxLine = z.infer<typeof BoxLine>;
export type BoxMedia = z.infer<typeof BoxMedia>;
export type MediaLink = z.infer<typeof MediaLink>;
export type LinkState = (typeof LINK_STATES)[number];
export type LinkStateOfBox = z.infer<typeof LinkStateOfBox>;
export type Dial = z.infer<typeof Dial>;
export type DialValue = z.infer<typeof DialValue>;
export type IconName = z.infer<typeof IconName>;
export type Frame = z.infer<typeof Frame>;
export type Wire = z.infer<typeof Wire>;
export type Stroke = z.infer<typeof Stroke>;
export type ReadElement = z.infer<typeof ReadElement>;
export type Step = z.infer<typeof Step>;
export type Element = z.infer<typeof Element>;
export type ElementInput = z.infer<typeof ElementInput>;
export type BoxInput = z.infer<typeof BoxInput>;
export type Board = z.infer<typeof Board>;
export type Op = z.infer<typeof Op>;
export type BoardChange = z.infer<typeof BoardChange>;
export type BoardReview = z.infer<typeof BoardReview>;
export type WorthALookPath = z.infer<typeof WorthALookPath>;
export type BoardHead = z.infer<typeof BoardHead>;
export type BoardSummary = z.infer<typeof BoardSummary>;
export type BoardOutline = z.infer<typeof BoardOutline>;
export type BoardRegion = z.infer<typeof BoardRegion>;
export type BoardRecord = z.infer<typeof BoardRecord>;
export type WhiteboardAgentRequest = z.infer<typeof WhiteboardAgentRequest>;
export type WhiteboardAgentReply = z.infer<typeof WhiteboardAgentReply>;

import { z } from 'zod';
import { DEVICE_FITS, DEVICE_NAMES } from '../whiteboard-devices.ts';
import { ICON_NAMES } from '../whiteboard-icons.ts';
import { elementTableOf, isElementTable } from '../whiteboard-element-table.ts';
import type { ElementTable } from '../whiteboard-element-table.ts';

export const WHITEBOARD_LIMITS = Object.freeze({
  elements: 1_000_000, opsPerPut: 5000, putBytes: 1_728_576, title: 80, line: 120, linesPerBox: 12, noteText: 400, logEntries: 2000, layoutWarnings: 20, readPage: 150, readPageChars: 32_000, outlineClusters: 40, queryText: 200, boxWidthMin: 160, boxWidthMax: 960, boxHeightMax: 2400, dialsPerPage: 16, dialChoices: 12, strokePoints: 1000, strokes: 500, strokeWidthMax: 24,
});


const ElementId = z.string({ error: 'an id must be a string' })
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit' })
  .meta({ id: 'ElementId' });

const Title = z.string().max(WHITEBOARD_LIMITS.title, { error: `a title is at most ${WHITEBOARD_LIMITS.title} characters` });

export const AnchorRef = z.string().min(1).max(200, { error: 'a ref is at most 200 characters' })
  .regex(/^[^#\s]+(#L[1-9]\d*(-L[1-9]\d*)?)?$/, { error: 'a ref is path, path#L12 or path#L12-L30' })
  .meta({ id: 'AnchorRef', description: 'a code location: path, path#L12 or path#L12-L30' });

export const IconName = z.enum(ICON_NAMES).meta({ id: 'IconName', description: 'a catalog icon, drawn in the text color' });
export const DeviceName = z.enum(DEVICE_NAMES).meta({ id: 'DeviceName', description: 'a catalog device drawn around the box media' });
const DeviceFit = z.enum(DEVICE_FITS).default('fill').describe('fill covers the screen and crops; fit shows all of the media, letterboxed');

const AnchorRefs = z.array(AnchorRef).max(8, { error: 'an element carries at most 8 refs' }).default([]);

export const BoxLine = z.object({
  text: z.string().max(WHITEBOARD_LIMITS.line, { error: `a box line is at most ${WHITEBOARD_LIMITS.line} characters` }),
  muted: z.boolean().default(false),
  style: z.enum(['text', 'code', 'item', 'numbered', 'kv']).default('text'),
  key: z.string().max(40, { error: 'a line key is at most 40 characters' }).nullable().default(null),
  ref: AnchorRef.nullable().default(null),
  icon: IconName.nullable().default(null).describe('drawn before the line text'),
}).strict().refine((line) => line.style !== 'kv' || Boolean(line.key), { error: 'a kv line needs a key' }).meta({ id: 'BoxLine' });

const Point = z.object({ x: z.number(), y: z.number() }).strict().meta({ id: 'Point' });

export const BOX_CHANGES = ['none', 'added', 'removed', 'relabeled'] as const;
export const WIRE_TONES = ['plain', 'fail', 'join'] as const;
export const STICKY_TONES = ['yellow', 'pink', 'green', 'blue', 'violet'] as const;
export type StickyTone = (typeof STICKY_TONES)[number];
export const STICKY_TONE_HEX: Readonly<Record<StickyTone, string>> = { yellow: '#f5d565', pink: '#f28bb6', green: '#7fd49a', blue: '#7cb4f2', violet: '#b49cf5' };

export const STEP_STATUSES = ['planned', 'building', 'landed'] as const;

const Side = z.enum(['left', 'right', 'top', 'bottom']).meta({ id: 'Side' });

export const Near = z.object({
  of: ElementId,
  side: Side,
  gap: z.number().int().min(0).default(60),
}).strict().meta({ id: 'Near' });

const Output = z.object({
  id: ElementId,
  label: z.string().min(1, { error: 'an output needs a label' }).max(30, { error: 'an output label is at most 30 characters' }),
}).strict().meta({ id: 'Output' });

export const WHITEBOARD_ASSET_ROUTE = '/whiteboards/assets';
export const WHITEBOARD_PICTURE_ROUTE = '/whiteboards/pictures';
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

export const BoxMedia = z.object({
  kind: z.enum(BOARD_MEDIA_KINDS).describe('what the media is, as attach returned it'),
  asset: AssetId,
  mime: z.enum(BOARD_MEDIA_MIMES).describe('the media type, as attach returned it'),
  width: z.number().int().min(1).max(BOARD_MEDIA_MAX_EDGE_PX).describe('the media width in pixels, as attach returned it'),
  height: z.number().int().min(1).max(BOARD_MEDIA_MAX_EDGE_PX).describe('the media height in pixels, as attach returned it'),
  alt: z.string().max(WHITEBOARD_LIMITS.line, { error: `a media alt is at most ${WHITEBOARD_LIMITS.line} characters` }).default(''),
  hasPreview: z.boolean().default(false).describe('whether attach stored a smaller preview beside the original'),
  dials: DialManifest.default([]).describe('the dials a page declares, as attach returned them'),
}).strict().meta({ id: 'BoxMedia' });

export const BoardMediaUploadReply = z.object({ ok: z.literal(true), media: BoxMedia }).strict();

export const Step = z.object({
  status: z.enum(STEP_STATUSES).default('planned'),
  linkedBoardId: z.string().min(1).max(64).nullable().default(null).describe('a board holding this step in detail'),
}).strict().meta({ id: 'Step' });

const boxBaseFields = {
  kind: z.literal('box'),
  id: ElementId,
  title: Title.min(1, { error: 'a box needs a title' }),
  icon: IconName.nullable().default(null).describe('drawn before the title'),
  refs: AnchorRefs,
  change: z.enum(BOX_CHANGES).default('none').describe('marks the box in a diff'),
  was: Title.nullable().default(null).describe('the old title, required when change is relabeled'),
  order: z.number().int().default(0).describe('position in the panel stack, lowest first'),
  at: Point.nullable().default(null).describe('place: a point on the board'),
  width: z.number().int()
    .min(WHITEBOARD_LIMITS.boxWidthMin, { error: `a box width is ${WHITEBOARD_LIMITS.boxWidthMin} to ${WHITEBOARD_LIMITS.boxWidthMax}` })
    .max(WHITEBOARD_LIMITS.boxWidthMax, { error: `a box width is ${WHITEBOARD_LIMITS.boxWidthMin} to ${WHITEBOARD_LIMITS.boxWidthMax}` })
    .nullable().default(null).describe(`the box width in board units, ${WHITEBOARD_LIMITS.boxWidthMin} to ${WHITEBOARD_LIMITS.boxWidthMax}; null is the 220 default`),
  height: z.number().int()
    .min(1, { error: `a box height is 1 to ${WHITEBOARD_LIMITS.boxHeightMax}` })
    .max(WHITEBOARD_LIMITS.boxHeightMax, { error: `a box height is 1 to ${WHITEBOARD_LIMITS.boxHeightMax}` })
    .nullable().default(null).describe('the least box height in board units; the box still grows to fit its content; null fits the content'),
  step: Step.nullable().default(null).describe('makes the box a plan step; a wire from one step to another means the second is built after the first'),
};

const boxContentFields = {
  lines: z.array(BoxLine).max(WHITEBOARD_LIMITS.linesPerBox, { error: `a box holds at most ${WHITEBOARD_LIMITS.linesPerBox} lines` }).default([]),
  media: BoxMedia.nullable().default(null).describe('media drawn under the lines, from whiteboard attach'),
  params: DialParams,
};

const Borderless = z.boolean().default(false).describe('draws the box with no card fill or outline, so its lines, media or device stand alone');

const Outputs = z.array(Output).max(8, { error: 'a decision has at most 8 outputs' });

const OnlyDecisionOutputs = z.array(Output).max(0, { error: 'only a decision has outputs, so set shape to decision' }).optional()
  .describe('accepted only empty: outputs belong to a decision');

const NoIconBoxContent = z.never({ error: 'an icon box holds no lines or media, so set shape to box first' }).optional()
  .describe('refused: an icon box holds no lines or media');

const plainBoxFields = { ...boxBaseFields, shape: z.literal('box').default('box'), ...boxContentFields, borderless: Borderless };
const decisionBoxFields = { ...boxBaseFields, shape: z.literal('decision').describe('draws a diamond with outputs'), ...boxContentFields, outputs: Outputs.default([]).describe('decision branches; a wire leaves one through fromOutput') };
const panelBoxFields = { ...boxBaseFields, shape: z.literal('panel').describe('draws a side note card'), ...boxContentFields };
const stickyBoxFields = {
  ...boxBaseFields, shape: z.literal('sticky').describe('draws a sticky note in its tone'), ...boxContentFields,
  tone: z.enum(STICKY_TONES).default('yellow').describe('the sticky note color'),
};
const noteBoxFields = { ...boxBaseFields, shape: z.literal('note').describe('draws a pinned note card; wire it dashed to the box it is about, and remove it to resolve'), ...boxContentFields };
const NoTextBoxContent = z.never({ error: 'a text box holds only a title and lines, so set shape to box first' }).optional()
  .describe('refused: a text box holds only a title and lines');
const textBoxFields = { ...boxBaseFields, shape: z.literal('text').describe('draws its title and lines as plain text with no border'), lines: boxContentFields.lines };
const NoDeviceBoxLines = z.never({ error: 'a device box holds no lines, so set shape to box first' }).optional()
  .describe('refused: a device box holds no lines');

const iconBoxFields = { ...boxBaseFields, shape: z.literal('icon').describe('draws its icon large with the title under it, and holds no lines or media'), icon: IconName };
const deviceBoxFields = {
  ...boxBaseFields,
  shape: z.literal('device').describe('draws a device with its media on the screen, or an empty screen without media'),
  device: DeviceName,
  fit: DeviceFit,
  borderless: Borderless,
  media: BoxMedia.nullable().default(null).describe('media drawn on the device screen, from whiteboard attach'),
  params: DialParams,
};

const FIELD_NAMES_BY_SHAPE = Object.freeze({
  box: new Set(Object.keys(plainBoxFields)),
  decision: new Set(Object.keys(decisionBoxFields)),
  panel: new Set(Object.keys(panelBoxFields)),
  icon: new Set(Object.keys(iconBoxFields)),
  device: new Set(Object.keys(deviceBoxFields)),
  sticky: new Set(Object.keys(stickyBoxFields)),
  note: new Set(Object.keys(noteBoxFields)),
  text: new Set(Object.keys(textBoxFields)),
});

export const BOX_SHAPES = ['box', 'decision', 'panel', 'icon', 'device', 'sticky', 'note', 'text'] as const;

const nearInputField = { near: Near.nullable().default(null).describe('place: beside another box, once; the box is stored at the point it lands on') };

function boxShapesWith<ExtraFields extends z.ZodRawShape>(extraFields: ExtraFields, placeDescription: string) {
  return z.discriminatedUnion('shape', [
    z.object({ ...plainBoxFields, ...extraFields, outputs: OnlyDecisionOutputs }).strict(),
    z.object({ ...decisionBoxFields, ...extraFields }).strict(),
    z.object({ ...panelBoxFields, ...extraFields, outputs: OnlyDecisionOutputs }).strict(),
    z.object({ ...iconBoxFields, ...extraFields, lines: NoIconBoxContent, media: NoIconBoxContent }).strict(),
    z.object({ ...deviceBoxFields, ...extraFields, lines: NoDeviceBoxLines }).strict(),
    z.object({ ...stickyBoxFields, ...extraFields, outputs: OnlyDecisionOutputs }).strict(),
    z.object({ ...noteBoxFields, ...extraFields, outputs: OnlyDecisionOutputs }).strict(),
    z.object({ ...textBoxFields, ...extraFields, outputs: OnlyDecisionOutputs, media: NoTextBoxContent, params: NoTextBoxContent }).strict(),
  ], { error: `a box shape is ${BOX_SHAPES.join(', ')}` }).describe(placeDescription);
}

export const Box = boxShapesWith({}, 'a box sits at a point; a plan step may have none and joins the build-order band, and a panel may have none and stacks right of the drawing');
export const BoxInput = boxShapesWith(nearInputField, 'a box needs one place: near or at; a plan step may have none and joins the build-order band, and a panel may have none and stacks right of the drawing');

export function fieldNamesOfShape(shape: Box['shape']): ReadonlySet<string> {
  return FIELD_NAMES_BY_SHAPE[shape];
}

export function linesOfBox(box: Box): readonly BoxLine[] {
  return box.shape === 'icon' || box.shape === 'device' ? [] : box.lines;
}

export function isBorderlessBox(box: Box): boolean {
  return (box.shape === 'box' || box.shape === 'device') && box.borderless;
}

export function mediaOfBox(box: Box): BoxMedia | null {
  return box.shape === 'icon' || box.shape === 'text' ? null : box.media;
}

function paramsOfBox(box: Box): Readonly<Record<string, DialValue>> {
  return box.shape === 'icon' || box.shape === 'text' ? {} : box.params;
}

export function dialValuesOfBox(box: Box): Record<string, DialValue> {
  const media = mediaOfBox(box);
  if (media?.kind !== 'page') return {};
  const params = paramsOfBox(box);
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

export function dialParamsProblemOf(box: Box): string | null {
  const dialsById = new Map((mediaOfBox(box)?.dials ?? []).map((dial) => [dial.id, dial]));
  for (const [dialId, value] of Object.entries(paramsOfBox(box))) {
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
  loop: z.boolean().default(false),
  collapsed: z.boolean().default(false).describe('a stack: draws as one card showing its first box, hides the rest, and ends their wires at the card; a box sits in at most one collapsed frame'),
}).strict();

export const Wire = z.object({
  kind: z.literal('wire'),
  id: ElementId,
  from: ElementId.describe('the element id it starts at'),
  to: ElementId.describe('the element id it ends at'),
  fromOutput: ElementId.nullable().default(null).describe('the output id of a decision from'),
  dashed: z.boolean().default(false),
  tone: z.enum(WIRE_TONES).default('plain'),
  label: z.string().max(40, { error: 'a wire label is at most 40 characters' }).nullable().default(null),
  fromSide: Side.nullable().default(null),
  toSide: Side.nullable().default(null),
  back: z.boolean().default(false).describe('a return edge, drawn against the flow'),
}).strict();

export const STROKE_TONES = ['ink', ...STICKY_TONES] as const;

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
  back: z.boolean().default(false),
  label: z.string().min(1, { error: 'a legend entry needs a label' }).max(40, { error: 'a legend label is at most 40 characters' }),
}).strict()).max(12, { error: 'a legend has at most 12 entries' });

const CodeSessionId = z.string().min(1).max(64);
const ProjectPath = z.string().min(1).max(4096);

export const Board = z.object({
  id: z.string().min(1).max(64),
  title: Title.min(1),
  version: z.number().int().nonnegative(),
  caption: z.string().max(400).nullable(),
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
  z.object({ op: z.literal('board'), title: Title.min(1).optional(), caption: z.string().max(400).nullable().optional(), legend: LegendEntries.optional(), codeSessionId: CodeSessionId.nullable().optional() }).strict(),
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
  }).strict(),
], { error: 'whiteboard takes new, list, connect, disconnect, get, query, put, doc, delete, attach or show' });

export const WorthALookPath = z.object({ path: z.string(), reason: z.string() }).strict();

export const BoardReview = z.object({
  codeSessionId: z.string().nullable(),
  anchorWarnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  stepWarnings: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  uncoveredPaths: z.array(z.string()).max(WHITEBOARD_LIMITS.layoutWarnings),
  worthALook: z.array(WorthALookPath).max(WHITEBOARD_LIMITS.layoutWarnings),
  flaggedStepIds: z.array(ElementId).max(WHITEBOARD_LIMITS.elements),
  notChecked: z.string().nullable(),
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

export function boardMediaDrawnFilename(media: Pick<BoxMedia, 'kind' | 'asset' | 'mime' | 'hasPreview'>): string | null {
  if (media.hasPreview) return `${media.asset}.preview.webp`;
  return media.kind === 'image' ? boardMediaOriginalFilename(media) : null;
}

export function elementInputOf(element: Element): ElementInput {
  return element.kind === 'box' ? { ...element, near: null } : element;
}

export function sparseElement(element: Element): unknown {
  return withoutDefaults(Element, element);
}

type SparseElement = z.input<typeof Element>;
type SparseBox = z.input<typeof Box>;

function filledLine(line: z.input<typeof BoxLine>): BoxLine {
  return { text: line.text, muted: line.muted ?? false, style: line.style ?? 'text', key: line.key ?? null, ref: line.ref ?? null, icon: line.icon ?? null };
}

function filledMedia(media: z.input<typeof BoxMedia> | null | undefined): BoxMedia | null {
  if (!media) return null;
  return { kind: media.kind, asset: media.asset, mime: media.mime, width: media.width, height: media.height, alt: media.alt ?? '', hasPreview: media.hasPreview ?? false, dials: media.dials?.length ? DialManifest.parse(media.dials) : [] };
}

function filledBoxBase(box: SparseBox) {
  return {
    kind: 'box' as const, id: box.id, title: box.title, icon: box.icon ?? null, refs: box.refs ?? [], change: box.change ?? 'none', was: box.was ?? null,
    order: box.order ?? 0, at: box.at ?? null, width: box.width ?? null, height: box.height ?? null,
    step: box.step ? { status: box.step.status ?? 'planned', linkedBoardId: box.step.linkedBoardId ?? null } : null,
  };
}

function filledBox(box: SparseBox): Box {
  switch (box.shape) {
    case 'icon': return { ...filledBoxBase(box), icon: box.icon, shape: 'icon' };
    case 'device': return { ...filledBoxBase(box), params: box.params ?? {}, shape: 'device', device: box.device, fit: box.fit ?? 'fill', borderless: box.borderless ?? false, media: filledMedia(box.media) };
    case 'decision': return { ...filledBoxBase(box), params: box.params ?? {}, shape: 'decision', lines: (box.lines ?? []).map(filledLine), media: filledMedia(box.media), outputs: box.outputs ?? [] };
    case 'sticky': return { ...filledBoxBase(box), params: box.params ?? {}, shape: 'sticky', tone: box.tone ?? 'yellow', lines: (box.lines ?? []).map(filledLine), media: filledMedia(box.media), ...(box.outputs ? { outputs: box.outputs } : {}) };
    case 'text': return { ...filledBoxBase(box), shape: 'text', lines: (box.lines ?? []).map(filledLine), ...(box.outputs ? { outputs: box.outputs } : {}) };
    case 'note': return { ...filledBoxBase(box), params: box.params ?? {}, shape: 'note', lines: (box.lines ?? []).map(filledLine), media: filledMedia(box.media), ...(box.outputs ? { outputs: box.outputs } : {}) };
    case 'panel': return { ...filledBoxBase(box), params: box.params ?? {}, shape: 'panel', lines: (box.lines ?? []).map(filledLine), media: filledMedia(box.media), ...(box.outputs ? { outputs: box.outputs } : {}) };
    default: return { ...filledBoxBase(box), params: box.params ?? {}, shape: 'box', borderless: box.borderless ?? false, lines: (box.lines ?? []).map(filledLine), media: filledMedia(box.media), ...(box.outputs ? { outputs: box.outputs } : {}) };
  }
}

export function filledElement(element: SparseElement): Element {
  switch (element.kind) {
    case 'box': return filledBox(element);
    case 'frame': return { kind: 'frame', id: element.id, title: element.title, contains: element.contains, loop: element.loop ?? false, collapsed: element.collapsed ?? false };
    case 'wire': return {
      kind: 'wire', id: element.id, from: element.from, to: element.to, fromOutput: element.fromOutput ?? null, dashed: element.dashed ?? false, tone: element.tone ?? 'plain',
      label: element.label ?? null, fromSide: element.fromSide ?? null, toSide: element.toSide ?? null, back: element.back ?? false,
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
export type BoxLine = z.infer<typeof BoxLine>;
export type BoxMedia = z.infer<typeof BoxMedia>;
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

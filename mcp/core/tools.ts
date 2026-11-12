import { z } from 'zod';

import {
  AgentAttentionRequest, AgentCloseRequest, AgentEditRequest, AgentPacksRequest, AgentPullRequestRequest, AgentSettingsRequest, AgentSpawnRequest, AgentWhyRequest, AgentCommentsRequest,
} from '../../shared/contracts/session.ts';
import { AgentNeedRequest } from '../../shared/contracts/secrets.ts';
import type { AgentApiVerb } from '../../shared/contracts/session.ts';
import { BoardRegion, Op, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import { BOX_SHAPES } from '../../shared/whiteboard-shapes.ts';
import { BUILTIN_AGENT_IDS, SHELL_AGENT_ID } from '../../shared/contracts/config.ts';
import { RaceId } from '../../shared/contracts/race.ts';
import { MAX_WAKE_TEXT_CHARS, MAX_WAKE_WHEN_CHARS, WakeId } from '../../shared/contracts/wakes.ts';

type ToolArguments = Record<string, unknown>;

interface CallContext {
  resolveSessionPath(requestedPath: string): string;
  ownsSpawnedSessions: boolean;
}

type Presenter = 'agent-reply' | 'board-with-reading' | 'board-picture' | 'board-render' | 'spawn-reply' | 'board-without-command-guide' | 'settings-list' | 'reply-text';

type ActionHints = { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean };

interface ActionRoute {
  verb: AgentApiVerb;
  presenter?: Presenter;
  required: readonly string[];
  accepts: readonly string[];
  hints: ActionHints;
  toPayload(toolArguments: ToolArguments, context: CallContext): Record<string, unknown>;
}

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

interface GroupedTool {
  name: string;
  title: string;
  description: string;
  loadsUpfront: boolean;
  fields: z.ZodRawShape;
  actions: Readonly<Record<string, ActionRoute>>;
}

type ToolCallRoute = { ok: true; verb: AgentApiVerb; presenter: Presenter; payload: Record<string, unknown> } | { ok: false; error: string };

const SPAWNABLE_AGENT_IDS = BUILTIN_AGENT_IDS.filter((agentId) => agentId !== SHELL_AGENT_ID).join(', ');

const ChildField = z.string().min(1).max(300).describe('The spawned session, by the id or name spawn returned');
const BoardField = z.string().min(1).max(200).describe('The board, by id or title');

function definedEntries(source: ToolArguments, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

const READS: ActionHints = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const WRITES: ActionHints = { readOnly: false, destructive: false, idempotent: false, openWorld: false };
const REWRITES: ActionHints = { readOnly: false, destructive: false, idempotent: true, openWorld: false };
const DESTROYS: ActionHints = { readOnly: false, destructive: true, idempotent: false, openWorld: false };

type RouteShape = { required?: readonly string[]; hints: ActionHints; presenter?: Presenter };

function routeTo(verb: AgentApiVerb, keys: readonly string[], { required = [], hints, presenter }: RouteShape): ActionRoute {
  return { verb, presenter, required, accepts: keys, hints, toPayload: (toolArguments) => definedEntries(toolArguments, keys) };
}

function sendPayload(toolArguments: ToolArguments): Record<string, unknown> {
  const text = typeof toolArguments.text === 'string' ? toolArguments.text : '';
  const child = typeof toolArguments.child === 'string' ? toolArguments.child : null;
  return { words: child === null ? [text] : [child, text] };
}

function answerPayload(toolArguments: ToolArguments): Record<string, unknown> {
  if (toolArguments.toOperator === true) return definedEntries(toolArguments, ['child', 'toOperator']);
  return definedEntries(toolArguments, ['child', 'answers']);
}

function editPayload(toolArguments: ToolArguments, context: CallContext): Record<string, unknown> {
  if (typeof toolArguments.path !== 'string') return {};
  return { path: context.resolveSessionPath(toolArguments.path) };
}

function whiteboardRoute(sub: string, keys: readonly string[], { required = [], hints, presenter = 'agent-reply' }: RouteShape): ActionRoute {
  return { verb: 'whiteboard', presenter, required, accepts: keys, hints, toPayload: (toolArguments) => ({ sub, ...definedEntries(toolArguments, keys) }) };
}

function attachPayload(toolArguments: ToolArguments, context: CallContext): Record<string, unknown> {
  if (typeof toolArguments.path !== 'string') return { sub: 'attach' };
  return { sub: 'attach', path: context.resolveSessionPath(toolArguments.path) };
}

function boardPictureRoute(): ActionRoute {
  return {
    verb: 'whiteboard', presenter: 'board-picture', required: ['board'], accepts: ['board', 'region'], hints: READS,
    toPayload: (toolArguments) => ({ sub: 'get', peek: true, ...definedEntries(toolArguments, ['board', 'region']) }),
  };
}

function boardRenderRoute(): ActionRoute {
  return {
    verb: 'whiteboard', presenter: 'board-render', required: ['board'], accepts: ['board', 'format', 'scale'], hints: { ...WRITES, idempotent: true },
    toPayload: (toolArguments) => definedEntries(toolArguments, ['board', 'format', 'scale']),
  };
}

const SESSION_TOOL: GroupedTool = {
  name: 'session',
  title: 'Glimmervoid sessions',
  description: 'Spawn, message and manage Glimmervoid sessions. spawn starts a new supervised session with its own dashboard card and worktree, an option beside an in-process subagent. send and read talk with a spawned child (or, from a child, its parent); answer replies to a question a child asked; close ends a child; sessions lists every live session; edit opens a file for the operator to write or correct, such as a plan or a prompt; limits reports what this session may do.',
  loadsUpfront: true,
  fields: {
    prompt: AgentSpawnRequest.shape.prompt.optional().describe('spawn: the task for the new session'),
    name: AgentSpawnRequest.shape.name.describe('spawn: a display name for the new session'),
    agent: AgentSpawnRequest.shape.agent.describe(`spawn: the agent to run, one of ${SPAWNABLE_AGENT_IDS} or a custom agent id; defaults to this session's`),
    child: ChildField.optional(),
    text: z.string().min(1).max(20000).optional().describe('send: the message'),
    discard: AgentCloseRequest.shape.discard.describe('close: drop the child\'s unpushed work instead of refusing'),
    answers: z.record(z.string(), z.string().min(1)).optional().describe('answer: each question text mapped to the chosen answer'),
    toOperator: z.literal(true).optional().describe('answer: pass the child\'s question to the operator instead'),
    path: AgentEditRequest.shape.path.optional().describe('edit: the file, absolute or relative to this session\'s directory'),
  },
  actions: {
    spawn: routeTo('spawn', ['prompt', 'name', 'agent'], { required: ['prompt'], hints: WRITES, presenter: 'spawn-reply' }),
    send: { verb: 'send', required: ['text'], accepts: ['child', 'text'], hints: WRITES, toPayload: sendPayload },
    read: routeTo('read', ['child'], { hints: WRITES }),
    close: routeTo('close', ['child', 'discard'], { required: ['child'], hints: DESTROYS }),
    answer: { verb: 'answer', required: ['child'], accepts: ['child', 'answers', 'toOperator'], hints: WRITES, toPayload: answerPayload },
    sessions: routeTo('sessions', [], { hints: READS }),
    edit: { verb: 'edit', required: ['path'], accepts: ['path'], hints: WRITES, toPayload: editPayload },
    limits: routeTo('limits', [], { hints: READS }),
  },
};

const WHITEBOARD_TOOL: GroupedTool = {
  name: 'whiteboard',
  title: 'Glimmervoid whiteboards',
  description: `Draw diagrams, architecture maps and plans on a shared whiteboard the operator sees and edits on the dashboard; prefer it to a diagram in chat. new creates a board and list names this project's boards in use (all: true names every board); every other action needs a board that exists, so draw on the board the operator opened beside this session when the prompt names one, and otherwise call list or new first. get reads one with what changed since this session last read it; a board over ${WHITEBOARD_LIMITS.readPage} elements or too much text for one page comes back as an outline (counts, bounds, frames, clusters elsewhere) plus the elements in its focus region, which is the operator's current view until you pass region to look elsewhere; query pages elements by region, ids or text; view returns a picture of it as the operator sees it, small enough to read inline, so pass region to picture one part of a large board with text you can read; render writes the whole board to a file Glimmervoid keeps, a PNG at 1 to 3 times its size or an SVG, media included, and replies with the file's path, so copy that file to export a board or read it for a sharp picture; put applies element ops (add, set, remove, and align to give boxes one top and height as a row or one left and width as a column; every box takes a place, a point {at}, {near} another box, aside stacked right of the drawing, or plan in the build-order band for a plan step, and a shape, ${BOX_SHAPES.join(', ')}; a box with a step is a plan step, and a wire from one step to another orders them); get and put also return the plan steps in build order and any layout warnings to fix, connect and disconnect follow a board's changes, a note is a box with shape note wired dashed to the box it is about and removed once settled, delete removes a board of this session's project, attach stores a PNG, JPEG, WebP, GIF, SVG, MP4, WebM, HTML or Markdown file and returns the media a box takes to show it, and doc reads the Markdown text of the document a box shows, as the operator last saved it.`,
  loadsUpfront: true,
  fields: {
    board: BoardField.optional(),
    title: z.string().min(1).max(200).optional().describe('new: the board title'),
    ops: z.array(Op).min(1).optional().describe('put: the element ops to apply'),
    box: z.string().min(1).max(40).optional().describe('doc: the id of the box whose document to read'),
    all: z.boolean().optional().describe('list: every board in every project, archived ones too, instead of this project\'s boards in use'),
    peek: z.boolean().optional().describe('get: read without marking changes as seen; view never marks them'),
    review: z.boolean().optional().describe('get: include the plan review against the code session'),
    region: BoardRegion.optional().describe('get: the focus region to read in full, kept as this session\'s focus until the operator view changes; query: the region to page through; view: the part of the board to picture, at up to twice its size'),
    ids: z.array(z.string()).min(1).max(WHITEBOARD_LIMITS.readPage).optional().describe('query: the element ids to read'),
    text: z.string().min(1).max(WHITEBOARD_LIMITS.queryText).optional().describe('query: words to find in element titles, lines and notes'),
    cursor: z.string().max(40).optional().describe('get, query: the nextCursor a previous read returned, to read the next page of the same read'),
    path: z.string().min(1).max(4096).optional().describe('attach: the image file, absolute or relative to this session\'s directory'),
    format: z.enum(['png', 'svg']).optional().describe('render: the kind of file to write, png unless given'),
    scale: z.number().int().min(1).max(3).optional().describe('render: how many pixels a PNG gets per board unit, 1, 2 or 3, and 2 unless given; a large board gets fewer'),
  },
  actions: {
    list: whiteboardRoute('list', ['all'], { hints: READS }),
    new: whiteboardRoute('new', ['title'], { required: ['title'], hints: WRITES, presenter: 'board-without-command-guide' }),
    get: whiteboardRoute('get', ['board', 'peek', 'review', 'region', 'cursor'], { required: ['board'], hints: REWRITES, presenter: 'board-with-reading' }),
    query: whiteboardRoute('query', ['board', 'region', 'ids', 'text', 'cursor'], { required: ['board'], hints: READS }),
    view: boardPictureRoute(),
    render: boardRenderRoute(),
    put: whiteboardRoute('put', ['board', 'ops'], { required: ['board', 'ops'], hints: DESTROYS, presenter: 'board-with-reading' }),
    connect: whiteboardRoute('connect', ['board'], { required: ['board'], hints: REWRITES, presenter: 'board-without-command-guide' }),
    disconnect: whiteboardRoute('disconnect', ['board'], { required: ['board'], hints: REWRITES }),
    doc: whiteboardRoute('doc', ['board', 'box'], { required: ['board', 'box'], hints: READS, presenter: 'reply-text' }),
    delete: whiteboardRoute('delete', ['board'], { required: ['board'], hints: { ...DESTROYS, idempotent: true } }),
    attach: { verb: 'whiteboard', required: ['path'], accepts: ['path'], hints: { ...WRITES, idempotent: true }, toPayload: attachPayload },
  },
};

const REVIEW_TOOL: GroupedTool = {
  name: 'review',
  title: 'Glimmervoid pull request reviews',
  description: 'Team pull request reviews and the operator\'s review comments on this session\'s changes. review queues a review of a pull request whose draft waits in the Reviews tab for the operator to post; reviews lists queued and finished reviews, or one review\'s detail; prs lists the operator\'s own open pull requests; link-pr links a pull request to this session\'s card. comments lists the open comments the operator left in Changes; reply answers one by commentId, shown under it in Changes; resolve closes one by commentId.',
  loadsUpfront: false,
  fields: {
    pr: AgentPullRequestRequest.shape.pr.optional().describe('A GitHub pull request url or owner/repo#number'),
    commentId: AgentCommentsRequest.shape.commentId.describe('reply, resolve: the review comment id, for example c-0123abcd'),
    text: AgentCommentsRequest.shape.text.describe('reply: the answer to show under the comment'),
  },
  actions: {
    review: routeTo('review', ['pr'], { required: ['pr'], hints: { ...WRITES, openWorld: true } }),
    reviews: routeTo('reviews', ['pr'], { hints: READS }),
    prs: routeTo('prs', [], { hints: { ...READS, openWorld: true } }),
    'link-pr': routeTo('link-pr', ['pr'], { required: ['pr'], hints: REWRITES }),
    comments: { verb: 'comments', required: [], accepts: [], hints: READS, toPayload: () => ({ command: 'list' }) },
    reply: { verb: 'comments', required: ['commentId', 'text'], accepts: ['commentId', 'text'], hints: WRITES, toPayload: (toolArguments) => ({ command: 'reply', ...definedEntries(toolArguments, ['commentId', 'text']) }) },
    resolve: { verb: 'comments', required: ['commentId'], accepts: ['commentId'], hints: { ...WRITES, idempotent: true }, toPayload: (toolArguments) => ({ command: 'resolve', ...definedEntries(toolArguments, ['commentId']) }) },
  },
};

const PUSH_TOOL: GroupedTool = {
  name: 'push',
  title: 'Glimmervoid push',
  description: 'Land this session\'s commits on the integration branch and push it. Use it instead of git push when a plain push is refused.',
  loadsUpfront: false,
  fields: {},
  actions: { push: routeTo('push', [], { hints: { ...DESTROYS, openWorld: true } }) },
};

const ATTENTION_TOOL: GroupedTool = {
  name: 'attention',
  title: 'Glimmervoid attention',
  description: 'Ask the operator for attention with a short note shown on the dashboard and in notifications, when this session needs a decision but is not stopping.',
  loadsUpfront: false,
  fields: { note: AgentAttentionRequest.shape.note.optional().describe('What the operator should look at') },
  actions: { attention: routeTo('attention', ['note'], { hints: { ...WRITES, openWorld: true } }) },
};

const SECRETS_TOOL: GroupedTool = {
  name: 'secrets',
  title: 'Glimmervoid secrets',
  description: "Ask for API keys and other secrets by environment variable name instead of asking the operator to paste them into chat. The first time, the operator approves each name on this session's card; Glimmervoid then reads it from the operator's vault and writes it to .env.local in this session's directory. Load that file, do not read it: use your framework's env loading or node --env-file=.env.local. The reply gives a status per name, never a value: delivered, pending (ask again later), denied, companion-offline or failed.",
  loadsUpfront: false,
  fields: { names: AgentNeedRequest.shape.names.describe('The secret names, for example ["OPENAI_API_KEY"]') },
  actions: { need: routeTo('need', ['names'], { required: ['names'], hints: { ...WRITES, openWorld: true } }) },
};

function showPayload(toolArguments: ToolArguments, context: CallContext): Record<string, unknown> {
  const caption = typeof toolArguments.caption === 'string' ? { caption: toolArguments.caption } : {};
  const link = typeof toolArguments.link === 'boolean' ? { link: toolArguments.link } : {};
  if (typeof toolArguments.path !== 'string') return { sub: 'show', ...caption, ...link };
  return { sub: 'show', path: context.resolveSessionPath(toolArguments.path), ...caption, ...link };
}

const SHOW_TOOL: GroupedTool = {
  name: 'show',
  title: 'Glimmervoid show',
  description: 'Show the operator an image, video, HTML page or Markdown document you made (a screenshot, a rendered chart, a report, a mockup, a demo clip, a draft they should edit) as a card on a whiteboard on their dashboard. Use it instead of publishing an artifact, pasting a picture into chat, or asking the operator to open a file: the operator is already watching the board, and the card stays there for them and other sessions to see and edit. It puts the card on the board this session is connected to, creating one titled after the file when there is none (to pick the board title, create it with whiteboard new first), and returns the board and the box id so whiteboard put can change it. Accepts PNG, JPEG, WebP, GIF, SVG, MP4, WebM, HTML or Markdown on this machine, up to 200 MB, a Markdown document up to 256 KiB; the operator can edit a Markdown document on the board. An HTML page brings the images, styles, fonts and scripts it refers to by a relative path in its folder or below, and the reply names each local file that did not load; a file the page loads only from script at run time (fetch, a Worker, new URL) is not brought, so put its contents in the page. With link, a Markdown or HTML file in the board code session worktree stays tied to the file: the card follows it when the board is read, and an operator save of a linked Markdown card writes the file.',
  loadsUpfront: true,
  fields: {
    path: z.string().min(1).max(4096).describe('The file, absolute or relative to this session\'s directory'),
    caption: z.string().min(1).max(WHITEBOARD_LIMITS.line).optional().describe('A short line shown under the file on its card'),
    link: z.boolean().optional().describe('Tie a Markdown or HTML card to the file in the board code session worktree, so the card follows the file when the board is read and an operator save writes it'),
  },
  actions: { show: { verb: 'whiteboard', required: ['path'], accepts: ['path', 'caption', 'link'], hints: WRITES, toPayload: showPayload } },
};

const SETTINGS_TOOL: GroupedTool = {
  name: 'settings',
  title: 'Glimmervoid settings',
  description: 'Read Glimmervoid\'s own settings without opening config.json. list names every setting; get reads one by its dotted path.',
  loadsUpfront: false,
  fields: { path: AgentSettingsRequest.shape.path.describe('get: the dotted setting path') },
  actions: {
    list: { verb: 'settings', presenter: 'settings-list', required: [], accepts: [], hints: READS, toPayload: () => ({ command: 'list' }) },
    get: { verb: 'settings', required: ['path'], accepts: ['path'], hints: READS, toPayload: (toolArguments) => ({ command: 'get', ...definedEntries(toolArguments, ['path']) }) },
  },
};

const PACKS_TOOL: GroupedTool = {
  name: 'packs',
  title: 'Glimmervoid packs',
  description: 'Build and install Glimmervoid packs: folders that add color themes, sandboxed HTML dashboard panels and My PRs commands. guide returns how packs work, the pack.json and panel bridge JSON Schemas and example packs to copy; read it before writing a pack. check validates a pack folder and lists what it adds; install checks a folder and copies it into Glimmervoid\'s packs folder, where it waits for approval; preview checks a folder and shows its panels with sample data as a live page card on this session\'s board; request-approval asks the operator to approve an installed pack; status reads one pack\'s approval state and problems; list names every pack here; remove deletes a pack install made. Only the operator approves a pack, in Settings, Packs; no action here can.',
  loadsUpfront: false,
  fields: {
    path: AgentPacksRequest.shape.path.describe('check, install, preview: the pack folder, absolute or relative to this session\'s directory'),
    name: AgentPacksRequest.shape.name.describe('status, request-approval, remove: the pack name from its pack.json'),
  },
  actions: {
    guide: { verb: 'packs', presenter: 'reply-text', required: [], accepts: [], hints: READS, toPayload: () => ({ command: 'guide' }) },
    check: { verb: 'packs', presenter: 'reply-text', required: ['path'], accepts: ['path'], hints: READS, toPayload: (toolArguments) => ({ command: 'check', ...definedEntries(toolArguments, ['path']) }) },
    list: { verb: 'packs', presenter: 'reply-text', required: [], accepts: [], hints: READS, toPayload: () => ({ command: 'list' }) },
    install: { verb: 'packs', presenter: 'reply-text', required: ['path'], accepts: ['path'], hints: WRITES, toPayload: (toolArguments) => ({ command: 'install', ...definedEntries(toolArguments, ['path']) }) },
    preview: { verb: 'packs', presenter: 'reply-text', required: ['path'], accepts: ['path'], hints: WRITES, toPayload: (toolArguments) => ({ command: 'preview', ...definedEntries(toolArguments, ['path']) }) },
    status: { verb: 'packs', presenter: 'reply-text', required: ['name'], accepts: ['name'], hints: READS, toPayload: (toolArguments) => ({ command: 'status', ...definedEntries(toolArguments, ['name']) }) },
    'request-approval': { verb: 'packs', presenter: 'reply-text', required: ['name'], accepts: ['name'], hints: { ...WRITES, openWorld: true }, toPayload: (toolArguments) => ({ command: 'request-approval', ...definedEntries(toolArguments, ['name']) }) },
    remove: { verb: 'packs', presenter: 'reply-text', required: ['name'], accepts: ['name'], hints: DESTROYS, toPayload: (toolArguments) => ({ command: 'remove', ...definedEntries(toolArguments, ['name']) }) },
  },
};

const WHY_TOOL: GroupedTool = {
  name: 'why',
  title: 'Glimmervoid why',
  description: 'Name the Glimmervoid session, agent, task and prompt that made a line or commit. target is <file>:<line>, relative to this session\'s directory, or a commit sha.',
  loadsUpfront: true,
  fields: { target: AgentWhyRequest.shape.target.describe('<file>:<line> or a commit sha') },
  actions: { why: routeTo('why', ['target'], { required: ['target'], hints: READS }) },
};

function subcommandRoute(verb: AgentApiVerb, sub: string, keys: readonly string[], { required = [], hints }: RouteShape): ActionRoute {
  return { verb, required, accepts: keys, hints, toPayload: (toolArguments) => ({ sub, ...definedEntries(toolArguments, keys) }) };
}

const ARENA_TOOL: GroupedTool = {
  name: 'arena',
  title: 'Glimmervoid Arena',
  description: 'Start, follow and judge Arena races, where one prompt runs on 2 to 5 agent setups, each in its own session and worktree from the same commit, and a judge ranks the contestants that changed something. start races a prompt in this session\'s project and returns the race id; races lists the loaded races newest first; race reads one with its phase (running, judging, judged), contestant sessions, finishes, diff stats, check results and judge panel; judge starts judging a race now instead of waiting for every contestant to settle; diff reads one contestant\'s diff against the start commit. The operator picks the winner in the Arena tab.',
  loadsUpfront: false,
  fields: {
    spec: z.record(z.string(), z.unknown()).optional().describe('start: the race, as {title, prompt, contestants: [{id, label, setup: {agent, model (null for the default), options: [], instructions: \'\'}, home: operator}] (2 to 5), judges: [{setup}] on claude-code or codex, optional check, timeLimitMinutes and rounds}; the project is this session\'s'),
    race: RaceId.optional().describe('race, judge, diff: the race id'),
    contestant: RaceId.optional().describe('diff: the contestant id, such as c1'),
  },
  actions: {
    start: subcommandRoute('arena', 'start', ['spec'], { required: ['spec'], hints: WRITES }),
    races: subcommandRoute('arena', 'races', [], { hints: READS }),
    race: subcommandRoute('arena', 'race', ['race'], { required: ['race'], hints: READS }),
    judge: subcommandRoute('arena', 'judge', ['race'], { required: ['race'], hints: WRITES }),
    diff: subcommandRoute('arena', 'diff', ['race', 'contestant'], { required: ['race', 'contestant'], hints: READS }),
  },
};

const WAKE_TOOL: GroupedTool = {
  name: 'wake',
  title: 'Glimmervoid wake',
  description: "Have Glimmervoid type a prompt into this session later, to come back to a task (check a rollout, a slow job, a pull request) instead of polling or sleeping. It is typed in once the session is idle and the operator is not typing, framed as Glimmervoid wake <id>. in takes a duration (30s, 15m, 2h, 1h30m); at takes a clock time HH:MM or an ISO date-time; cron takes a five-field pattern such as 0 9 * * 1-5 and fires for up to 7 days. Times use the operator's timezone. list shows this session's pending wakes; cancel removes one by id. After 10 wakes with no operator input, wakes stop until the operator types.",
  loadsUpfront: false,
  fields: {
    when: z.string().min(1).max(MAX_WAKE_WHEN_CHARS).optional().describe('in: a duration such as 15m; at: HH:MM or an ISO date-time; cron: a five-field pattern'),
    text: z.string().min(1).max(MAX_WAKE_TEXT_CHARS).optional().describe('in, at, cron: the prompt to type into this session, one line'),
    wake: WakeId.optional().describe('cancel: the wake id, such as w3'),
  },
  actions: {
    in: subcommandRoute('wake', 'in', ['when', 'text'], { required: ['when', 'text'], hints: WRITES }),
    at: subcommandRoute('wake', 'at', ['when', 'text'], { required: ['when', 'text'], hints: WRITES }),
    cron: subcommandRoute('wake', 'cron', ['when', 'text'], { required: ['when', 'text'], hints: WRITES }),
    list: subcommandRoute('wake', 'list', [], { hints: READS }),
    cancel: subcommandRoute('wake', 'cancel', ['wake'], { required: ['wake'], hints: DESTROYS }),
  },
};

const GROUPED_TOOLS: readonly GroupedTool[] = Object.freeze([SESSION_TOOL, WHITEBOARD_TOOL, REVIEW_TOOL, SHOW_TOOL, PUSH_TOOL, ATTENTION_TOOL, SECRETS_TOOL, SETTINGS_TOOL, PACKS_TOOL, WHY_TOOL, ARENA_TOOL, WAKE_TOOL]);

function allowedActionNames(tool: GroupedTool, isVerbAllowed: (verb: AgentApiVerb) => boolean): string[] {
  return Object.entries(tool.actions).filter(([, route]) => isVerbAllowed(route.verb)).map(([actionName]) => actionName);
}

function inputSchemaFor(tool: GroupedTool, actionNames: readonly string[]): z.ZodObject {
  const [firstAction, ...otherActions] = actionNames;
  if (firstAction === undefined || Object.keys(tool.actions).length === 1) return z.object(tool.fields);
  return z.object({
    action: z.enum([firstAction, ...otherActions]).describe('What to do'),
    ...tool.fields,
  });
}

function combinedAnnotations(tool: GroupedTool, actionNames: readonly string[]): ToolAnnotations {
  const hints = actionNames.flatMap((actionName) => tool.actions[actionName]?.hints ?? []);
  return {
    readOnlyHint: hints.every((hint) => hint.readOnly),
    destructiveHint: hints.some((hint) => hint.destructive),
    idempotentHint: hints.every((hint) => hint.idempotent),
    openWorldHint: hints.some((hint) => hint.openWorld),
  };
}

function namedList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const CHILD_TARGETING_ACTIONS: ReadonlySet<string> = new Set(['send', 'read']);

function argumentProblem(callName: string, route: ActionRoute, toolArguments: ToolArguments, context: CallContext): string | null {
  if (!context.ownsSpawnedSessions && CHILD_TARGETING_ACTIONS.has(route.verb) && toolArguments.child !== undefined) {
    return 'this session has no spawned sessions: send and read reach its parent, so drop child';
  }
  const presentKeys = Object.keys(toolArguments).filter((key) => key !== 'action' && toolArguments[key] !== undefined);
  const strayKeys = presentKeys.filter((key) => !route.accepts.includes(key));
  if (strayKeys.length > 0) {
    const accepted = route.accepts.length === 0 ? 'takes no other fields' : `takes ${namedList(route.accepts)}`;
    return `${callName} ${accepted}, so drop ${namedList(strayKeys)}`;
  }
  const required = route.verb === 'send' && context.ownsSpawnedSessions ? ['child', ...route.required] : route.required;
  const missingKeys = required.filter((key) => toolArguments[key] === undefined);
  if (missingKeys.length > 0) return `${callName} needs ${namedList(missingKeys)}`;
  return null;
}

function routeToolCall(tool: GroupedTool, toolArguments: ToolArguments, context: CallContext): ToolCallRoute {
  const actionNames = Object.keys(tool.actions);
  const requestedAction = actionNames.length === 1 ? actionNames[0] : toolArguments.action;
  const route = typeof requestedAction === 'string' && Object.hasOwn(tool.actions, requestedAction) ? tool.actions[requestedAction] : undefined;
  if (route === undefined || typeof requestedAction !== 'string') return { ok: false, error: `${tool.name} takes action ${namedList(actionNames)}` };
  const callName = actionNames.length === 1 ? tool.name : `${tool.name} ${requestedAction}`;
  const problem = argumentProblem(callName, route, toolArguments, context);
  if (problem !== null) return { ok: false, error: problem };
  return { ok: true, verb: route.verb, presenter: route.presenter ?? 'agent-reply', payload: route.toPayload(toolArguments, context) };
}

export { GROUPED_TOOLS, allowedActionNames, combinedAnnotations, inputSchemaFor, routeToolCall };
export type { CallContext, GroupedTool, Presenter, ToolArguments, ToolCallRoute };

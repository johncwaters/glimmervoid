import { z } from 'zod';

import {
  AgentAttentionRequest, AgentCloseRequest, AgentEditRequest, AgentPullRequestRequest, AgentSettingsRequest, AgentSpawnRequest,
} from '../../shared/contracts/session.ts';
import type { AgentApiVerb } from '../../shared/contracts/session.ts';
import { Op } from '../../shared/contracts/whiteboard.ts';

type ToolArguments = Record<string, unknown>;

interface CallContext {
  resolveSessionPath(requestedPath: string): string;
}

type Presenter = 'agent-reply' | 'show-by-path' | 'board-with-reading' | 'board-picture';

interface ActionRoute {
  verb: AgentApiVerb;
  presenter?: Presenter;
  toPayload(toolArguments: ToolArguments, context: CallContext): Record<string, unknown>;
}

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

interface GroupedTool {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  loadsUpfront: boolean;
  fields: z.ZodRawShape;
  actions: Readonly<Record<string, ActionRoute>>;
}

type ToolCallRoute = { ok: true; verb: AgentApiVerb; presenter: Presenter; payload: Record<string, unknown> } | { ok: false; error: string };

const ChildField = z.string().min(1).max(300).describe('The spawned session, by the id or name spawn returned');
const BoardField = z.string().min(1).max(200).describe('The board, by id or title');

function definedEntries(source: ToolArguments, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function routeTo(verb: AgentApiVerb, keys: readonly string[] = []): ActionRoute {
  return { verb, toPayload: (toolArguments) => definedEntries(toolArguments, keys) };
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

function whiteboardRoute(sub: string, keys: readonly string[], presenter: Presenter = 'agent-reply'): ActionRoute {
  return { verb: 'whiteboard', presenter, toPayload: (toolArguments) => ({ sub, ...definedEntries(toolArguments, keys) }) };
}

function boardPictureRoute(): ActionRoute {
  return { verb: 'whiteboard', presenter: 'board-picture', toPayload: (toolArguments) => ({ sub: 'get', peek: true, ...definedEntries(toolArguments, ['board']) }) };
}

const SESSION_TOOL: GroupedTool = {
  name: 'session',
  title: 'Glimmervoid sessions',
  description: 'Spawn, message and manage Glimmervoid sessions. spawn starts a new supervised session with its own dashboard card and worktree for work that edits files or runs long; prefer it to an in-process subagent, which stays fine for a quick read-only lookup. send and read talk with a spawned child (or, from a child, its parent); answer replies to a question a child asked; close ends a child; board lists every live session; edit opens a file for the operator to write or correct, such as a plan or a prompt; limits reports what this session may do.',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  loadsUpfront: true,
  fields: {
    prompt: AgentSpawnRequest.shape.prompt.optional().describe('spawn: the task for the new session'),
    name: AgentSpawnRequest.shape.name.describe('spawn: a display name for the new session'),
    agent: AgentSpawnRequest.shape.agent.describe('spawn: the agent CLI to run, such as claude, codex or kimi; defaults to this session\'s'),
    child: ChildField.optional(),
    text: z.string().min(1).max(20000).optional().describe('send: the message'),
    discard: AgentCloseRequest.shape.discard.describe('close: drop the child\'s unpushed work instead of refusing'),
    answers: z.record(z.string(), z.string().min(1)).optional().describe('answer: each question text mapped to the chosen answer'),
    toOperator: z.literal(true).optional().describe('answer: pass the child\'s question to the operator instead'),
    path: AgentEditRequest.shape.path.optional().describe('edit: the file, absolute or relative to this session\'s directory'),
  },
  actions: {
    spawn: routeTo('spawn', ['prompt', 'name', 'agent']),
    send: { verb: 'send', toPayload: sendPayload },
    read: routeTo('read', ['child']),
    close: routeTo('close', ['child', 'discard']),
    answer: { verb: 'answer', toPayload: answerPayload },
    board: routeTo('board'),
    edit: { verb: 'edit', toPayload: editPayload },
    limits: routeTo('limits'),
  },
};

const WHITEBOARD_TOOL: GroupedTool = {
  name: 'whiteboard',
  title: 'Glimmervoid whiteboards',
  description: 'Draw diagrams, architecture maps and plans on a shared whiteboard the operator sees and edits on the dashboard; prefer it to a diagram in chat. new creates a board, list names them, get reads one with what changed since this session last read it, view returns a picture of it as the operator sees it, put applies element ops (add, set, remove; a unit element is a plan step); get and put also return the plan steps in build order and any layout warnings to fix, connect and disconnect follow a board\'s changes, resolve closes a note, delete removes a board this session created.',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  loadsUpfront: true,
  fields: {
    board: BoardField.optional(),
    title: z.string().min(1).max(200).optional().describe('new: the board title'),
    ops: z.array(Op).min(1).optional().describe('put: the element ops to apply'),
    note: z.string().min(1).max(200).optional().describe('resolve: the note element id'),
    peek: z.boolean().optional().describe('get: read without marking changes as seen; view never marks them'),
    review: z.boolean().optional().describe('get: include the plan review against the code session'),
  },
  actions: {
    list: whiteboardRoute('list', []),
    new: whiteboardRoute('new', ['title']),
    get: whiteboardRoute('get', ['board', 'peek', 'review'], 'board-with-reading'),
    view: boardPictureRoute(),
    put: whiteboardRoute('put', ['board', 'ops'], 'board-with-reading'),
    connect: whiteboardRoute('connect', ['board']),
    disconnect: whiteboardRoute('disconnect', ['board']),
    resolve: whiteboardRoute('resolve', ['board', 'note']),
    delete: whiteboardRoute('delete', ['board']),
  },
};

const REVIEW_TOOL: GroupedTool = {
  name: 'review',
  title: 'Glimmervoid pull request reviews',
  description: 'Team pull request reviews. review queues a review of a pull request whose draft waits in the Reviews tab for the operator to post; reviews lists queued and finished reviews, or one review\'s detail; prs lists the operator\'s own open pull requests; link-pr links a pull request to this session\'s card.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  loadsUpfront: false,
  fields: {
    pr: AgentPullRequestRequest.shape.pr.optional().describe('A GitHub pull request url or owner/repo#number'),
  },
  actions: {
    review: routeTo('review', ['pr']),
    reviews: routeTo('reviews', ['pr']),
    prs: routeTo('prs'),
    'link-pr': routeTo('link-pr', ['pr']),
  },
};

const PUSH_TOOL: GroupedTool = {
  name: 'push',
  title: 'Glimmervoid push',
  description: 'Land this session\'s commits on the integration branch and push it. Use it instead of git push when a plain push is refused.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  loadsUpfront: false,
  fields: {},
  actions: { push: routeTo('push') },
};

const ATTENTION_TOOL: GroupedTool = {
  name: 'attention',
  title: 'Glimmervoid attention',
  description: 'Ask the operator for attention with a short note shown on the dashboard and in notifications, when this session needs a decision but is not stopping.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  loadsUpfront: false,
  fields: { note: AgentAttentionRequest.shape.note.optional().describe('What the operator should look at') },
  actions: { attention: routeTo('attention', ['note']) },
};

const SHOW_TOOL: GroupedTool = {
  name: 'show',
  title: 'Glimmervoid show',
  description: 'Put an image, video, PDF or HTML page on this session\'s dashboard card so the operator can see it, such as a screenshot, a rendered chart or a report. Glimmervoid reads the file by its path, so it must be on this machine and under 200 MB.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  loadsUpfront: false,
  fields: {
    path: z.string().min(1).max(4096).describe('The file, absolute or relative to this session\'s directory'),
    caption: z.string().min(1).max(500).optional().describe('A short line shown with the file'),
  },
  actions: { show: { ...routeTo('show', ['path', 'caption']), presenter: 'show-by-path' } },
};

const SETTINGS_TOOL: GroupedTool = {
  name: 'settings',
  title: 'Glimmervoid settings',
  description: 'Read Glimmervoid\'s own settings without opening config.json. list names every setting; get reads one by its dotted path.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  loadsUpfront: false,
  fields: { path: AgentSettingsRequest.shape.path.describe('get: the dotted setting path') },
  actions: {
    list: { verb: 'settings', toPayload: () => ({ command: 'list' }) },
    get: { verb: 'settings', toPayload: (toolArguments) => ({ command: 'get', ...definedEntries(toolArguments, ['path']) }) },
  },
};

const GROUPED_TOOLS: readonly GroupedTool[] = Object.freeze([SESSION_TOOL, WHITEBOARD_TOOL, REVIEW_TOOL, SHOW_TOOL, PUSH_TOOL, ATTENTION_TOOL, SETTINGS_TOOL]);

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

function routeToolCall(tool: GroupedTool, toolArguments: ToolArguments, context: CallContext): ToolCallRoute {
  const actionNames = Object.keys(tool.actions);
  const requestedAction = actionNames.length === 1 ? actionNames[0] : toolArguments.action;
  if (typeof requestedAction !== 'string' || !Object.hasOwn(tool.actions, requestedAction)) {
    return { ok: false, error: `${tool.name} takes action ${actionNames.join(', ')}` };
  }
  const route = tool.actions[requestedAction];
  if (route === undefined) return { ok: false, error: `${tool.name} takes action ${actionNames.join(', ')}` };
  return { ok: true, verb: route.verb, presenter: route.presenter ?? 'agent-reply', payload: route.toPayload(toolArguments, context) };
}

export { GROUPED_TOOLS, allowedActionNames, inputSchemaFor, routeToolCall };
export type { CallContext, GroupedTool, Presenter, ToolArguments, ToolCallRoute };

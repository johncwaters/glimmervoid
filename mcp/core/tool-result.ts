import { sparseBoardReply } from '../../shared/contracts/whiteboard.ts';

type ToolTextResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type ToolImageResult = {
  content: ({ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string })[];
};

function errorTextOf(body: Record<string, unknown>): string {
  return typeof body.error === 'string' && body.error ? body.error : 'Glimmervoid refused the request';
}

function toolResultFromReply(reply: { status: number; body: Record<string, unknown> }): ToolTextResult {
  if (reply.body.ok !== true) return { content: [{ type: 'text', text: errorTextOf(reply.body) }], isError: true };
  const wireBody = sparseBoardReply(reply.body);
  return { content: [{ type: 'text', text: JSON.stringify(wireBody) }], structuredContent: wireBody };
}

function toolErrorResult(message: string): ToolTextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export { toolErrorResult, toolResultFromReply };
export type { ToolImageResult, ToolTextResult };

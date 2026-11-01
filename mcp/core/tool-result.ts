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
  return { content: [{ type: 'text', text: JSON.stringify(reply.body) }], structuredContent: reply.body };
}

function toolErrorResult(message: string): ToolTextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export { toolErrorResult, toolResultFromReply };
export type { ToolImageResult, ToolTextResult };

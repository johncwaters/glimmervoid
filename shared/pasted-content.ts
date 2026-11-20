const PASTED_CONTENT_ENVELOPE = /<pasted_content\b([^>]*)>([\s\S]*?)<\/pasted_content\1>/gi;
const BLANK_EDGE_LINES = /^\s*\n|\n\s*$/g;

export function unwrapPastedContent(text: string): string {
  if (!text.includes('<pasted_content')) return text;
  return text.replace(PASTED_CONTENT_ENVELOPE, (_envelope, _attributes: string, pastedText: string) => pastedText.replace(BLANK_EDGE_LINES, '')).trim();
}

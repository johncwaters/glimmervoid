import { DialManifest } from '../../shared/contracts/whiteboard.ts';
import type { Dial } from '../../shared/contracts/whiteboard.ts';

export const DIAL_MANIFEST_SCAN_BYTES = 256 * 1024;
const PARAMS_TYPE_RE = /\btype\s*=\s*["']?application\/glimmervoid-params["'\s>]/i;

type DialManifestOutcome = { ok: true; dials: Dial[] } | { ok: false; error: string };

function manifestTextOf(pageHtml: string): string | null {
  const lowered = pageHtml.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < lowered.length) {
    const tagStart = lowered.indexOf('<script', searchFrom);
    if (tagStart === -1) return null;
    const tagEnd = lowered.indexOf('>', tagStart);
    if (tagEnd === -1) return null;
    const closeStart = lowered.indexOf('</script', tagEnd);
    if (closeStart === -1) return null;
    if (PARAMS_TYPE_RE.test(`${pageHtml.slice(tagStart, tagEnd)} >`)) return pageHtml.slice(tagEnd + 1, closeStart);
    searchFrom = closeStart + 1;
  }
  return null;
}

export function dialManifestOf(pageHtml: string): DialManifestOutcome {
  const manifestText = manifestTextOf(pageHtml);
  if (manifestText === null) return { ok: true, dials: [] };
  const declared = parsedJsonOf(manifestText);
  if (!declared.ok) return { ok: false, error: `its glimmervoid-params script is not JSON: ${declared.error}` };
  const parsed = DialManifest.safeParse(declared.value);
  if (parsed.success) return { ok: true, dials: parsed.data };
  const [issue] = parsed.error.issues;
  const dialIndex = typeof issue?.path[0] === 'number' ? issue.path[0] : null;
  const dialName = dialIndexNameOf(declared.value, dialIndex);
  return { ok: false, error: `${dialName}${issue?.message ?? 'its glimmervoid-params script is not a list of dials'}` };
}

function parsedJsonOf(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
  }
}

function dialIndexNameOf(declared: unknown, dialIndex: number | null): string {
  if (dialIndex === null || !Array.isArray(declared)) return '';
  const declaredDial: unknown = declared[dialIndex];
  const declaredId = typeof declaredDial === 'object' && declaredDial !== null && 'id' in declaredDial ? declaredDial.id : null;
  return typeof declaredId === 'string' ? `dial ${declaredId}: ` : `dial ${dialIndex + 1}: `;
}

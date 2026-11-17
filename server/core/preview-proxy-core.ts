import { PREVIEW_ROUTE } from '../../shared/contracts/session-previews.ts';

const PREVIEW_PATH_PATTERN = new RegExp(`^${PREVIEW_ROUTE}/([A-Za-z0-9-]{1,64})(?:[/?]|$)`);

const PREVIEW_CONTENT_POLICY = 'sandbox allow-scripts allow-forms';

const OPAQUE_ORIGIN = 'null';
const UPSTREAM_HEADERS_DROPPED = ['access-control-allow-origin', 'access-control-allow-credentials', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie', 'clear-site-data', 'strict-transport-security'];
export const OPERATOR_HEADERS_DROPPED: readonly string[] = ['cookie', 'authorization', 'x-glimmervoid-page-token'];

export function isPreviewRequestPath(requestPath: string): boolean {
  return requestPath === PREVIEW_ROUTE || requestPath.startsWith(`${PREVIEW_ROUTE}/`) || requestPath.startsWith(`${PREVIEW_ROUTE}?`);
}

export function previewSessionIdOf(requestPath: string): string | null {
  return PREVIEW_PATH_PATTERN.exec(requestPath)?.[1] ?? null;
}

export function previewBasePath(sessionId: string): string {
  return `${PREVIEW_ROUTE}/${sessionId}/`;
}

export function previewRefusal(port: number | null, glimmervoidPorts: readonly number[]): string | null {
  if (port === null) return 'this session has not shared a preview';
  if (glimmervoidPorts.includes(port)) return "a preview cannot point at Glimmervoid's own port";
  return null;
}

export function previewUpstreamHeaders(headers: Record<string, string | string[] | undefined>, requestOrigin: string | undefined): Record<string, string | string[] | undefined> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !UPSTREAM_HEADERS_DROPPED.includes(name.toLowerCase())));
  const sandboxed = { ...kept, 'content-security-policy': PREVIEW_CONTENT_POLICY, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin' };
  return requestOrigin === OPAQUE_ORIGIN ? { ...sandboxed, 'access-control-allow-origin': OPAQUE_ORIGIN } : sandboxed;
}

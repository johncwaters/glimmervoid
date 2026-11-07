import { isLoopbackHostname } from "../../shared/loopback-hosts.ts";
import { QUESTION_TOOL_HOLD_HOOK_EVENT, QUESTION_TOOL_HOLD_TIMEOUT_MS } from "../../shared/contracts/question-manager.ts";
const HOOK_URL_ENV = "GLIMMERVOID_HOOK_URL";

const MAX_PAYLOAD_BYTES = 65536;
const MAX_RESPONSE_BYTES = 65536;
const POST_TIMEOUT_MS = 1500;


const EVENT_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const HOOK_PATH_PREFIX = "/hook/";

interface RelayPostVerdict {
  post: boolean;
  url: string | null;
  event: string | null;
  postTimeoutMs: number;
  reason: string;
}

function readHookUrl(env: Record<string, unknown> | null | undefined): string | null {
  const raw = env ? env[HOOK_URL_ENV] : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function normalizeEvent(event: unknown): string | null {
  if (typeof event !== "string") return null;
  const trimmed = event.trim();
  if (!EVENT_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function resolveHookTarget(
  baseUrl: string,
  event: string,
  pathPrefix: string = HOOK_PATH_PREFIX,
): { url: string | null; reason: string } {
  let target: URL;
  try {
    target = new URL(baseUrl);
  } catch {
    return { url: null, reason: "bad-url" };
  }
  if (target.protocol !== "http:") return { url: null, reason: "not-http" };
  if (!isLoopbackHostname(target.hostname)) return { url: null, reason: "not-loopback" };
  if (!target.pathname.startsWith(pathPrefix)) return { url: null, reason: "not-hook-path" };
  const base = target.pathname.replace(/\/+$/, "");
  target.pathname = `${base}/${event}`;
  return { url: target.toString(), reason: "ok" };
}

function refusedPost(reason: string): RelayPostVerdict {
  return { post: false, url: null, event: null, postTimeoutMs: POST_TIMEOUT_MS, reason };
}

function decideRelayPost(
  { env = {}, event = null, payloadBytes = 0 }: {
    env?: Record<string, string | undefined>;
    event?: unknown;
    payloadBytes?: number;
  } = {},
): RelayPostVerdict {
  const baseUrl = readHookUrl(env);
  if (!baseUrl) return refusedPost("no-hook-url");
  const name = normalizeEvent(event);
  if (!name) return refusedPost("bad-event");
  if (!Number.isFinite(payloadBytes) || payloadBytes < 0) return refusedPost("bad-payload");
  if (payloadBytes > MAX_PAYLOAD_BYTES) return refusedPost("payload-too-large");
  const target = resolveHookTarget(baseUrl, name);
  if (!target.url) return refusedPost(target.reason);
  const postTimeoutMs = name === QUESTION_TOOL_HOLD_HOOK_EVENT ? QUESTION_TOOL_HOLD_TIMEOUT_MS : POST_TIMEOUT_MS;
  return { post: true, url: target.url, event: name, postTimeoutMs, reason: "ok" };
}

export {
  HOOK_URL_ENV,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
  POST_TIMEOUT_MS,
  resolveHookTarget,
  decideRelayPost,
};

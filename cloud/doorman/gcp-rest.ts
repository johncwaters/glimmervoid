import { z } from 'zod';

type GoogleRefusal = Error & { httpStatus: number };

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SECRET_MANAGER_ORIGIN = 'https://secretmanager.googleapis.com';
const REQUEST_TIMEOUT_MS = 15_000;

const MetadataToken = z.object({ access_token: z.string().min(1) });
const SecretVersionAccess = z.object({ payload: z.object({ data: z.string().min(1) }) });

function refusalOf(what: string, httpStatus: number): GoogleRefusal {
  return Object.assign(new Error(`${what} answered ${httpStatus}`), { httpStatus });
}

function isRefusal(error: unknown): error is GoogleRefusal {
  return error instanceof Error && 'httpStatus' in error && typeof error.httpStatus === 'number';
}

function isRetryableRefusal(error: unknown): boolean {
  return isRefusal(error) && (error.httpStatus === 429 || error.httpStatus >= 500);
}

function isTransientFailure(error: unknown): boolean {
  if (isRefusal(error)) return isRetryableRefusal(error);
  return error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
}

function createGcpRest({ fetchFn = fetch }: { fetchFn?: typeof fetch } = {}) {
  function send(url: string, init: RequestInit): Promise<Response> {
    return fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  async function okResponse(url: string, init: RequestInit, what: string, passedStatuses: ReadonlySet<number> = new Set()): Promise<Response> {
    const response = await send(url, init);
    if (response.ok || passedStatuses.has(response.status)) return response;
    await response.body?.cancel();
    throw refusalOf(what, response.status);
  }

  async function jsonFrom(url: string, init: RequestInit, what: string): Promise<unknown> {
    return (await okResponse(url, init, what)).json();
  }

  async function accessToken(): Promise<string> {
    return MetadataToken.parse(await jsonFrom(METADATA_TOKEN_URL, { headers: { 'metadata-flavor': 'Google' } }, 'the metadata server')).access_token;
  }

  async function authorized(init: RequestInit): Promise<RequestInit> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await accessToken()}`);
    return { ...init, headers };
  }

  async function authorizedJson(url: string, init: RequestInit, what: string): Promise<unknown> {
    return jsonFrom(url, await authorized(init), what);
  }

  async function authorizedResponse(url: string, init: RequestInit, what: string, passedStatuses: ReadonlySet<number>): Promise<Response> {
    return okResponse(url, await authorized(init), what, passedStatuses);
  }

  async function secretPayload(secretName: string, versionAlias: string): Promise<Buffer> {
    const secretUrl = `${SECRET_MANAGER_ORIGIN}/v1/${secretName}/versions/${versionAlias}:access`;
    return Buffer.from(SecretVersionAccess.parse(await authorizedJson(secretUrl, {}, 'Secret Manager')).payload.data, 'base64');
  }

  return { authorizedJson, authorizedResponse, secretPayload };
}

type GcpRest = ReturnType<typeof createGcpRest>;

export { createGcpRest, isRetryableRefusal, isTransientFailure };
export type { GcpRest };

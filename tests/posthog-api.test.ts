import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPosthogApi,
  normalizeIssue,
  normalizeIssues,
} from '../server/radar/posthog-api.ts';
import type { PosthogResponse, TrafficBuckets } from '../server/radar/posthog-api.ts';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function callAt(calls: FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (!call) throw new Error(`no fetch call at ${index}`);
  return call;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(init?.body ?? 'null'));
  if (!isRecord(parsed)) throw new Error('the request carried no JSON body');
  return parsed;
}

function hogqlQuery(init: RequestInit | undefined): { kind: unknown; query: string } {
  const { query } = sentBody(init);
  if (!isRecord(query)) throw new Error('the request carried no query block');
  const { kind, query: sql } = query;
  if (typeof sql !== 'string') throw new Error('the query block carries no SQL');
  return { kind, query: sql };
}

function trafficOf(res: TrafficBuckets | PosthogResponse): TrafficBuckets {
  if (!('buckets' in res)) throw new Error('the traffic query was refused');
  return res;
}

test('normalizeIssue maps a plain object row with nested aggregations', () => {
  const issue = normalizeIssue({
    id: 'iss-1',
    name: 'TypeError: boom',
    status: 'active',
    first_seen: '2026-08-01T00:00:00Z',
    last_seen: '2026-08-09T00:00:00Z',
    aggregations: { occurrences: 120, sessions: 40, users: 8 },
  });
  assert.deepEqual(issue, {
    issueId: 'iss-1',
    title: 'TypeError: boom',
    status: 'active',
    occurrences: 120,
    users: 8,
    firstSeen: '2026-08-01T00:00:00Z',
    lastSeen: '2026-08-09T00:00:00Z',
  });
});

test('normalizeIssues reads a positional { columns, results } matrix', () => {
  const issues = normalizeIssues({
    columns: ['id', 'name', 'occurrences', 'users'],
    results: [['a', 'boom', 12, 3]],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].issueId, 'a');
  assert.equal(issues[0].title, 'boom');
  assert.equal(issues[0].occurrences, 12);
  assert.equal(issues[0].users, 3);
});

function fakeResponse({ status = 200, body = {} }: { ok?: boolean; status?: number; body?: unknown } = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('queryIssues POSTs the documented body with a bearer token', async () => {
  const calls: FetchCall[] = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com/',
    apiKey: 'phx_secret',
    fetchFn: async (input, init) => { calls.push({ url: String(input), init }); return fakeResponse({ body: { results: [] } }); },
  });
  const res = await api.queryIssues(42, { dateRangeHours: 6 });

  assert.equal(res.ok, true);
  assert.equal(callAt(calls, 0).url, 'https://eu.posthog.com/api/projects/42/error_tracking/query/issues/');
  assert.equal(callAt(calls, 0).init?.method, 'POST');
  assert.equal(headerOf(callAt(calls, 0).init, 'authorization'), 'Bearer phx_secret');
  assert.deepEqual(sentBody(callAt(calls, 0).init), {
    orderBy: 'users',
    status: 'active',
    dateRange: { date_from: '-6h' },
    limit: 50,
    volumeResolution: 0,
  });
});

test('updateIssueStatus PATCHes the issue endpoint with the status body', async () => {
  const calls: FetchCall[] = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com/',
    apiKey: 'phx_secret',
    fetchFn: async (input, init) => { calls.push({ url: String(input), init }); return fakeResponse({ body: { status: 'resolved' } }); },
  });

  const res = await api.updateIssueStatus(42, 'iss-1', 'resolved');

  assert.equal(res.ok, true);
  assert.equal(callAt(calls, 0).url, 'https://eu.posthog.com/api/projects/42/error_tracking/issues/iss-1/');
  assert.equal(callAt(calls, 0).init?.method, 'PATCH');
  assert.equal(headerOf(callAt(calls, 0).init, 'authorization'), 'Bearer phx_secret');
  assert.deepEqual(sentBody(callAt(calls, 0).init), { status: 'resolved' });
});

function trafficFetch(calls: FetchCall[], bodies: unknown[]): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return fakeResponse({ body: bodies[calls.length - 1] });
  };
}

test('queryTrafficBuckets POSTs two HogQL queries to the query endpoint with a bearer token', async () => {
  const calls: FetchCall[] = [];
  const api = createPosthogApi({
    host: 'https://eu.posthog.com/',
    apiKey: 'phx_secret',
    fetchFn: trafficFetch(calls, [
      { columns: ['bucket', 'users'], results: [['2026-08-15T09:00:00Z', 12]] },
      { columns: ['users'], results: [[87]] },
    ]),
  });

  const res = await api.queryTrafficBuckets(42, { baselineDays: 7 });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://eu.posthog.com/api/projects/42/query/');
    assert.equal(call.init?.method, 'POST');
    assert.equal(headerOf(call.init, 'authorization'), 'Bearer phx_secret');
    assert.equal(hogqlQuery(call.init).kind, 'HogQLQuery');
  }
  const baselineSql = hogqlQuery(callAt(calls, 0).init).query;
  assert.match(baselineSql, /toStartOfHour\(timestamp\) AS bucket/);
  assert.match(baselineSql, /count\(DISTINCT person_id\) AS users/);
  assert.match(baselineSql, /INTERVAL 7 DAY/);
  assert.match(baselineSql, /timestamp < toStartOfHour\(now\(\)\)/, 'the partial current hour is excluded');
  assert.match(hogqlQuery(callAt(calls, 1).init).query, /INTERVAL 60 MINUTE/);
});

test('queryTrafficBuckets parses the positional HogQL matrix into buckets and a current count', async () => {
  const api = createPosthogApi({
    host: 'https://eu.posthog.com',
    apiKey: 'k',
    fetchFn: trafficFetch([], [
      { columns: ['bucket', 'users'], results: [['h1', 3], ['h2', '9']] },
      { columns: ['users'], results: [[87]] },
    ]),
  });
  const res = await api.queryTrafficBuckets(1, {});
  const traffic = trafficOf(res);
  assert.deepEqual(traffic.buckets, [{ bucket: 'h1', users: 3 }, { bucket: 'h2', users: 9 }]);
  assert.equal(traffic.currentUsers, 87);
});

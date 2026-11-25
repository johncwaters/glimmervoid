import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAwakeMeter } from '../cloud/doorman/awake-meter.ts';
import { createGcsDoormanState } from '../cloud/doorman/doorman-state.ts';
import { createGcpRest } from '../cloud/doorman/gcp-rest.ts';
import type { DoormanTenant } from '../shared/contracts/doorman.ts';

const BUCKET = 'tenant-state-bucket';
const QUIET_LOG = { warn: () => {} };

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition never held');
}

function createFakeCloudStorage() {
  const objectsByName = new Map<string, { bytes: Buffer; generation: number }>();
  let nextGeneration = 1;
  let conflictsLeft = 0;
  const secretsByName = new Map<string, string>();
  const failingReadNames = new Set<string>();
  const pendingAckIds: string[] = [];
  const acknowledgedAckIds: string[] = [];
  const pullWaiters = new Set<() => void>();
  let nextAckId = 1;

  function announce(objectName: string): void {
    if (objectName !== 'tenants.json' && !objectName.startsWith('routes/')) return;
    pendingAckIds.push(`ack-${nextAckId}`);
    nextAckId += 1;
    for (const wake of pullWaiters) wake();
  }

  function store(objectName: string, bytes: Buffer): void {
    objectsByName.set(objectName, { bytes, generation: nextGeneration });
    nextGeneration += 1;
    announce(objectName);
  }

  async function pull(signal: AbortSignal | null | undefined): Promise<Response> {
    while (pendingAckIds.length === 0) {
      await new Promise<void>((resolve, reject) => {
        pullWaiters.add(resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    pullWaiters.clear();
    return Response.json({ receivedMessages: pendingAckIds.splice(0).map((ackId) => ({ ackId, message: { attributes: {} } })) });
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'metadata.google.internal' && url.pathname.endsWith('/project/project-id')) return new Response('example-project');
    if (url.hostname === 'metadata.google.internal') return Response.json({ access_token: 'metadata-token' });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer metadata-token');
    if (url.hostname === 'secretmanager.googleapis.com') {
      const secretText = secretsByName.get(url.pathname.replace(/^\/v1\//, '').replace(/\/versions\/latest:access$/, ''));
      return secretText === undefined ? new Response('missing', { status: 404 }) : Response.json({ payload: { data: Buffer.from(secretText).toString('base64') } });
    }
    if (url.href === 'https://pubsub.googleapis.com/v1/projects/example-project/subscriptions/doorman-state:pull') return pull(init?.signal);
    if (url.href === 'https://pubsub.googleapis.com/v1/projects/example-project/subscriptions/doorman-state:acknowledge') {
      acknowledgedAckIds.push(...JSON.parse(String(init?.body)).ackIds);
      return Response.json({});
    }
    const objectsPath = `/storage/v1/b/${BUCKET}/o`;
    if (url.pathname === `/upload${objectsPath}`) {
      const objectName = url.searchParams.get('name') ?? '';
      const ifGeneration = url.searchParams.get('ifGenerationMatch');
      if (conflictsLeft > 0 && ifGeneration !== null) {
        conflictsLeft -= 1;
        store(objectName, Buffer.concat([objectsByName.get(objectName)?.bytes ?? Buffer.alloc(0), Buffer.from(`{"event":"slept","at":"2026-10-31T23:50:00.000Z"}\n`)]));
      }
      const current = objectsByName.get(objectName);
      if (ifGeneration !== null && String(current?.generation ?? 0) !== ifGeneration) return new Response('precondition', { status: 412 });
      store(objectName, Buffer.from(await new Response(init?.body).arrayBuffer()));
      return Response.json({ name: objectName });
    }
    if (url.pathname === objectsPath) {
      const prefix = url.searchParams.get('prefix') ?? '';
      return Response.json({ items: [...objectsByName.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name, generation: String(objectsByName.get(name)?.generation) })) });
    }
    const storedName = decodeURIComponent(url.pathname.slice(objectsPath.length + 1));
    if (failingReadNames.delete(storedName)) return new Response('unavailable', { status: 503 });
    const stored = objectsByName.get(storedName);
    if (stored === undefined) return new Response('missing', { status: 404 });
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(stored.bytes), { headers: { 'x-goog-generation': String(stored.generation) } });
    return Response.json({ generation: String(stored.generation) });
  };

  return {
    fetchFn,
    store: (objectName: string, text: string) => store(objectName, Buffer.from(text)),
    remove: (objectName: string) => {
      objectsByName.delete(objectName);
      announce(objectName);
    },
    acknowledgedAckIds,
    failNextRead: (objectName: string) => failingReadNames.add(objectName),
    textOf: (objectName: string) => objectsByName.get(objectName)?.bytes.toString('utf8') ?? null,
    names: () => [...objectsByName.keys()].sort(),
    conflictOnNextWrite: () => {
      conflictsLeft = 1;
    },
    putSecret: (secretName: string, secretText: string) => secretsByName.set(secretName, secretText),
  };
}

test('the Cloud Storage doorman state reads its table and Secret Manager link secrets, keeps watcher files per tenant, appends awake events into month objects under a generation match that survives a racing writer, and a restarted meter rebuilds usage and the edge wake cap from the newest months', async () => {
  const storage = createFakeCloudStorage();
  const linkSecretName = 'projects/example-project/secrets/tenant-link-statetenant0001';
  const tenant: DoormanTenant = { slug: 'statetenant0001', serverUrl: 'http://10.0.0.2:8080', linkSecret: { kind: 'secret-manager', secret: linkSecretName }, watcherHome: null, awakeHoursPerMonth: 10, host: null, owner: null };
  storage.store('tenants.json', JSON.stringify({ tenantDomain: 'tenants.example', tenants: [tenant] }));
  storage.putSecret(linkSecretName, `${'ab'.repeat(32)}\n`);
  storage.store('tenants/statetenant0001/ledger/2026-09.jsonl', '{"event":"woke","at":"2026-09-30T23:00:00.000Z"}\n');
  const state = createGcsDoormanState({ bucket: BUCKET, google: createGcpRest({ fetchFn: storage.fetchFn }), log: QUIET_LOG });

  assert.deepEqual((await state.readTable()).tenants.map((tableTenant) => tableTenant.slug), ['statetenant0001']);
  assert.equal(await state.tenantState.linkSecretHex(tenant), 'ab'.repeat(32));

  const watcherFiles = state.tenantState.watcherFilesOf(tenant);
  assert.equal(await watcherFiles.read('probe-set.json'), null);
  await watcherFiles.write('probe-set.json', '{"probes":[]}');
  assert.equal((await watcherFiles.read('probe-set.json'))?.toString('utf8'), '{"probes":[]}');

  let nowMs = Date.parse('2026-10-31T23:40:00.000Z');
  const ledger = state.tenantState.ledgerOf(tenant);
  const firstMeter = await createAwakeMeter({ ledger, now: () => nowMs, log: QUIET_LOG });
  firstMeter.note('slept');
  storage.conflictOnNextWrite();
  nowMs = Date.parse('2026-11-01T00:10:00.000Z');
  firstMeter.note('woke', 'edge');
  await firstMeter.flushed();

  assert.deepEqual(storage.names().filter((name) => name.includes('/ledger/')), ['tenants/statetenant0001/ledger/2026-09.jsonl', 'tenants/statetenant0001/ledger/2026-10.jsonl', 'tenants/statetenant0001/ledger/2026-11.jsonl']);
  assert.equal(storage.textOf('tenants/statetenant0001/ledger/2026-10.jsonl'), '{"event":"slept","at":"2026-10-31T23:50:00.000Z"}\n{"event":"slept","at":"2026-10-31T23:40:00.000Z"}\n');
  assert.equal(storage.textOf('tenants/statetenant0001/ledger/2026-11.jsonl'), '{"event":"woke","at":"2026-11-01T00:10:00.000Z","startedBy":"edge"}\n');

  nowMs = Date.parse('2026-11-01T00:40:00.000Z');
  const restartedMeter = await createAwakeMeter({ ledger, now: () => nowMs, log: QUIET_LOG });
  assert.equal(restartedMeter.isAwake(), true);
  assert.equal(restartedMeter.usage(10).usedMs, 30 * 60_000);
  assert.deepEqual(restartedMeter.recentEdgeWakeTimesMs(), [Date.parse('2026-11-01T00:10:00.000Z')]);
  assert.equal(restartedMeter.lastWokeAtMs(), Date.parse('2026-11-01T00:10:00.000Z'));
});

test('the Cloud Storage doorman state routes each routes/<slug>.json beside the tenant table, keeps the last good copy of a route that turns malformed, drops a deleted one, lets the table win a shared slug, and follows table and route changes through Pub/Sub, acknowledging a change only once it is applied', async (t) => {
  const storage = createFakeCloudStorage();
  const operatorTenant: DoormanTenant = { slug: 'operatortenant01', serverUrl: 'http://10.0.0.2:8080', linkSecret: { kind: 'secret-manager', secret: 'projects/example-project/secrets/tenant-link-operatortenant01' }, watcherHome: null, awakeHoursPerMonth: null, host: null, owner: null };
  const routedTenant: DoormanTenant = { ...operatorTenant, slug: 'routedtenant0001', serverUrl: 'http://10.0.0.3:8080', linkSecret: { kind: 'secret-manager', secret: 'projects/example-project/secrets/tenant-link-routedtenant0001' }, owner: { workosUserId: 'user_01ROUTED', authkitClientId: 'client_01ACCOUNTS', accountPageUrl: 'https://accounts.example' } };
  storage.store('tenants.json', JSON.stringify({ tenantDomain: 'tenants.example', tenants: [operatorTenant] }));
  storage.store('routes/routedtenant0001.json', JSON.stringify(routedTenant));
  storage.store('routes/operatortenant01.json', JSON.stringify({ ...routedTenant, slug: 'operatortenant01' }));
  storage.store('routes/claimedtenant001.json', JSON.stringify(routedTenant));
  const state = createGcsDoormanState({ bucket: BUCKET, google: createGcpRest({ fetchFn: storage.fetchFn }), log: QUIET_LOG });
  const tenantsOf = async () => (await state.readTable()).tenants.map((tenant) => [tenant.slug, tenant.owner?.workosUserId ?? null]);

  assert.deepEqual(await tenantsOf(), [['operatortenant01', null], ['routedtenant0001', 'user_01ROUTED']]);

  storage.store('routes/routedtenant0001.json', '{"slug":"routedtenant0001"');
  assert.deepEqual(await tenantsOf(), [['operatortenant01', null], ['routedtenant0001', 'user_01ROUTED']]);
  storage.failNextRead('routes/routedtenant0001.json');
  storage.store('routes/routedtenant0001.json', JSON.stringify({ ...routedTenant, serverUrl: 'http://10.0.0.4:8080' }));
  assert.equal((await state.readTable()).tenants[1].serverUrl, 'http://10.0.0.3:8080');
  assert.equal((await state.readTable()).tenants[1].serverUrl, 'http://10.0.0.4:8080');

  const appliedTenantLists: string[][] = [];
  let isNextReloadFailing = false;
  const stopWatching = state.watchTable(async () => {
    if (isNextReloadFailing) {
      isNextReloadFailing = false;
      return false;
    }
    appliedTenantLists.push((await state.readTable()).tenants.map((tenant) => tenant.slug));
    return true;
  });
  t.after(stopWatching);
  storage.remove('routes/routedtenant0001.json');
  await until(() => appliedTenantLists.length === 1);
  assert.deepEqual(appliedTenantLists, [['operatortenant01']], 'a removed route reaches the doorman through its Pub/Sub subscription, with no timed poll');
  await until(() => storage.acknowledgedAckIds.length > 0);
  const acknowledgedBeforeFailure = storage.acknowledgedAckIds.length;

  isNextReloadFailing = true;
  storage.store('routes/routedtenant0001.json', JSON.stringify(routedTenant));
  await until(() => !isNextReloadFailing);
  assert.equal(storage.acknowledgedAckIds.length, acknowledgedBeforeFailure, 'a change whose reload failed is not acknowledged, so Pub/Sub delivers it again');
  storage.remove('routes/routedtenant0001.json');

  storage.store('routes/routedtenant0001.json', JSON.stringify(routedTenant));
  storage.store('tenants.json', JSON.stringify({ tenantDomain: null, tenants: [operatorTenant] }));
  assert.deepEqual(await tenantsOf(), [['operatortenant01', null]]);
});

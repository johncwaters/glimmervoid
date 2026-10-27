import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPairingsStore, createSeenStore, pairingsSignature, SNAPSHOT_RELOAD_MS,
} from '../server/pairings-store.ts';
import type { PairedDevice, PairingsStore } from '../server/pairings-store.ts';
import { hashSecret } from '../server/core/pairing-token.ts';

interface InstalledInterval {
  ms: number | undefined;
  handle: NodeJS.Timeout;
  callback: () => void;
  unrefCalled: boolean;
  cleared: boolean;
}

interface StoreScope {
  store: PairingsStore;
  filePath: string;
  dir: string;
  warnings: string[];
}

function mintedToken(store: PairingsStore, name?: string): { token: string; expiresAt: number } {
  const minted = store.mintPending(name === undefined ? {} : { name });
  if (!minted) throw new Error('the mint was refused');
  return minted;
}

function redeemedDevice(store: PairingsStore, token: string, options?: { fallbackName?: string }): PairedDevice {
  const outcome = store.redeem(token, options);
  if (!outcome.device) throw new Error(`the redemption was refused: ${outcome.reason}`);
  return outcome.device;
}

function device(store: PairingsStore, id: string): PairedDevice {
  const found = store.findDevice(id);
  if (!found) throw new Error(`no device ${id}`);
  return found;
}

function readDoc(filePath: string): { version?: unknown; pending: Record<string, unknown>[]; devices: Record<string, unknown>[] } {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the pairings file is not a JSON object');
  const { version, pending, devices } = parsed as { version?: unknown; pending?: unknown; devices?: unknown };
  if (!Array.isArray(pending) || !Array.isArray(devices)) throw new Error('the pairings file carries no arrays');
  return { version, pending, devices };
}

function withTempStore<T>(run: (scope: StoreScope) => T, { clock }: { clock?: () => number } = {}): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pairings-'));
  const filePath = path.join(dir, 'pairings.json');
  const warnings: string[] = [];
  try {
    const store = createPairingsStore({
      filePath,
      now: clock || Date.now,
      warn: (message) => warnings.push(message),
    });
    return run({ store, filePath, dir, warnings });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('mint writes an atomic file holding only the token HASH', () => {
  withTempStore(({ store, filePath }) => {
    const minted = mintedToken(store, 'phone');
    const raw = fs.readFileSync(filePath, 'utf8');
    assert.equal(raw.includes(minted.token), false, 'the plaintext token is never persisted');
    const doc = readDoc(filePath);
    assert.equal(doc.version, 1);
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.pending[0]?.tokenHash, hashSecret(minted.token));
    assert.equal(doc.pending[0]?.name, 'phone');
    assert.equal(doc.pending[0]?.usedAt, null);
  });
});

test('redeem mints a device, marks the token used, and is single use', () => {
  withTempStore(({ store, filePath }) => {
    const minted = mintedToken(store, 'phone');
    const first = store.redeem(minted.token);
    assert.equal(first.ok, true);
    assert.ok(first.device, 'a device was minted');
    assert.equal(first.device.name, 'phone');
    const cookieValue = first.cookieValue;
    assert.ok(cookieValue, 'a cookie value was issued');
    assert.equal(cookieValue.startsWith(`${first.device.id}.`), true);

    const doc = readDoc(filePath);
    assert.equal(typeof doc.pending[0]?.usedAt, 'number');
    assert.equal(doc.devices.length, 1);
    assert.equal(String(doc.devices[0]?.secretHash).length, 64);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes(cookieValue), false, 'the cookie value is never persisted');

    const replay = store.redeem(minted.token);
    assert.deepEqual({ ok: replay.ok, reason: replay.reason }, { ok: false, reason: 'used' });
    assert.equal(readDoc(filePath).devices.length, 1, 'no second device from a replay');
  });
});

test('an expired token is rejected', () => {
  let clockValue = 1000;
  withTempStore(({ store }) => {
    const minted = mintedToken(store, 'phone');
    clockValue = minted.expiresAt + 1;
    const outcome = store.redeem(minted.token);
    assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: 'expired' });
  }, { clock: () => clockValue });
});

test('a corrupt file fails CLOSED: no devices, and writes are refused rather than clobbering it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pairings-bad-'));
  const filePath = path.join(dir, 'pairings.json');
  fs.writeFileSync(filePath, '{ this is not json', 'utf8');
  const warnings: string[] = [];
  try {
    const store = createPairingsStore({ filePath, warn: (message) => warnings.push(message) });
    assert.deepEqual(store.listDevices(), [], 'no devices means every remote request is refused');
    assert.equal(store.findDevice('anything'), null);
    assert.equal(store.mintPending({ name: 'x' }), null);
    assert.deepEqual(store.revokeDevice('x'), { ok: false, reason: 'write-failed' });
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{ this is not json', 'the unreadable file is left intact');
    assert.equal(warnings.length > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save re-reads before writing, so a concurrent revocation is not clobbered by a stale snapshot', () => {
  withTempStore(({ store, filePath }) => {
    const paired = redeemedDevice(store, mintedToken(store, 'phone').token);

    const onDisk = readDoc(filePath);
    const stored = onDisk.devices[0];
    assert.ok(stored, 'the redeemed device was persisted');
    stored.revokedAt = 12345;
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), 'utf8');

    assert.equal(typeof mintedToken(store, 'laptop').token, 'string');
    const after = readDoc(filePath);
    assert.equal(after.devices.find((row) => row.id === paired.id)?.revokedAt, 12345, 'the external revocation survived');
  });
});

test('watch installs one reload interval at SNAPSHOT_RELOAD_MS, unref-ed and cleared by the closer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pairings-timers-'));
  const filePath = path.join(dir, 'pairings.json');
  const intervals: InstalledInterval[] = [];
  const setIntervalFn = (callback: () => void, ms: number): NodeJS.Timeout => {
    const handle = setInterval(callback, ms);
    const entry: InstalledInterval = { ms, handle, callback, unrefCalled: false, cleared: false };
    const realUnref = handle.unref.bind(handle);
    handle.unref = () => {
      entry.unrefCalled = true;
      return realUnref();
    };
    intervals.push(entry);
    return handle;
  };
  const clearIntervalFn = (handle: NodeJS.Timeout): void => {
    const entry = intervals.find((candidate) => candidate.handle === handle);
    if (entry) entry.cleared = true;
    clearInterval(handle);
  };
  try {
    const writer = createPairingsStore({ filePath });
    const paired = redeemedDevice(writer, mintedToken(writer, 'phone').token);

    const reader = createPairingsStore({ filePath, setIntervalFn, clearIntervalFn });
    const stop = reader.watch(() => {});
    assert.equal(intervals.length, 1, 'exactly one reload interval');
    const installed = intervals[0];
    assert.ok(installed, 'the reload interval was captured');
    assert.equal(installed.ms, SNAPSHOT_RELOAD_MS);
    assert.equal(installed.unrefCalled, true, 'unref-ed so it never holds the process open');

    writer.revokeDevice(paired.id);
    installed.callback();
    assert.equal(typeof device(reader, paired.id).revokedAt, 'number', 'the interval refreshes the snapshot');

    stop();
    assert.equal(installed.cleared, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pairingsSignature ignores formatting and key order, tracks auth-relevant fields', () => {
  const base = { version: 1, pending: [], devices: [{ id: 'd1', secretHash: 'h', revokedAt: null }] };
  const reserialized = JSON.parse(JSON.stringify(base));
  assert.equal(pairingsSignature(base), pairingsSignature(reserialized), 'identical content, one signature');
  assert.notEqual(
    pairingsSignature(base),
    pairingsSignature({ version: 1, pending: [], devices: [{ id: 'd1', secretHash: 'h', revokedAt: 5 }] }),
    'a revocation must change the signature',
  );
  assert.notEqual(
    pairingsSignature(base),
    pairingsSignature({ version: 1, pending: [{ tokenHash: 't' }], devices: base.devices }),
    'a new pending token must change the signature',
  );
  assert.equal(pairingsSignature(null), pairingsSignature(undefined), 'garbage coerces to the empty doc');
});

test('an unchanged reload refreshes the snapshot but does NOT report a change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pairings-quiet-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    const paired = redeemedDevice(writer, mintedToken(writer, 'phone').token);

    const reader = createPairingsStore({ filePath });
    let changes = 0;
    const stop = reader.watch(() => { changes += 1; });
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, raw, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 0, 'no change reported for identical content');

      writer.revokeDevice(paired.id);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 1, 'a real revocation still reports exactly once');
      assert.equal(typeof device(reader, paired.id).revokedAt, 'number', 'and propagated to the snapshot');
    } finally {
      stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write to a sibling file in the watched directory reports no change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pairings-sibling-'));
  const filePath = path.join(dir, 'pairings.json');
  try {
    const writer = createPairingsStore({ filePath });
    writer.mintPending({ name: 'phone' });

    const reader = createPairingsStore({ filePath });
    let changes = 0;
    const stop = reader.watch(() => { changes += 1; });
    try {
      const seen = createSeenStore({ filePath: path.join(dir, 'pairings-seen.json'), throttleMs: 0 });
      seen.touch('device-1');
      await seen.pending;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(changes, 0, 'a seen-store write must not look like a device-list change');
    } finally {
      stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write refuses rather than racing while another process holds the lock', () => {
  withTempStore(({ store, filePath, warnings }) => {
    const paired = redeemedDevice(store, mintedToken(store, 'phone').token);
    const before = fs.readFileSync(filePath, 'utf8');

    fs.writeFileSync(`${filePath}.lock`, '', 'utf8');
    try {
      assert.deepEqual(store.revokeDevice(paired.id), { ok: false, reason: 'write-failed' });
      assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'the contended write touched nothing');
      assert.equal(warnings.some((message) => /lock/i.test(message)), true);
    } finally {
      fs.unlinkSync(`${filePath}.lock`);
    }
  });
});

test('pairing files are created 0600 on posix', { skip: process.platform === 'win32' ? 'posix modes only' : false }, () => {
  withTempStore(({ store, filePath }) => {
    store.mintPending({ name: 'phone' });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRequestOrigin, decideOwnerAccess, decideRequestAccess, decideUpgradeAccess, isPairPath, normalizePathname,
  normalizeClientTrust,
} from '../server/core/request-trust.ts';

test('normalizeClientTrust collapses an unstamped connection to local', () => {
  assert.equal(normalizeClientTrust('remote'), 'remote');
  assert.equal(normalizeClientTrust('local'), 'local');
  assert.equal(normalizeClientTrust(undefined), 'local',
    'remote mode off stamps no trust, and the client must read that as local');
  assert.equal(normalizeClientTrust(null), 'local');
  assert.equal(normalizeClientTrust('anything-else'), 'local');
});

test('with no remote listener every socket is local', () => {
  assert.equal(classifyRequestOrigin({ localPort: 3000, remoteListenerPort: null }), 'local');
  assert.equal(classifyRequestOrigin({ localPort: 3001, remoteListenerPort: null }), 'local');
  assert.equal(classifyRequestOrigin({ localPort: null, remoteListenerPort: null }), 'local');
});

test('only the remote listener port classifies as remote', () => {
  assert.equal(classifyRequestOrigin({ localPort: 3001, remoteListenerPort: 3001 }), 'remote');
  assert.equal(classifyRequestOrigin({ localPort: 3000, remoteListenerPort: 3001 }), 'local');
  assert.equal(classifyRequestOrigin({ localPort: undefined, remoteListenerPort: 3001 }), 'local');
});

test('isPairPath covers /pair and everything under it, and nothing that merely starts with the letters', () => {
  assert.equal(isPairPath('/pair'), true);
  assert.equal(isPairPath('/pair/abc'), true);
  assert.equal(isPairPath('/pairing'), false);
  assert.equal(isPairPath('/'), false);
  assert.equal(isPairPath(undefined), false);
});

test('normalizePathname decodes once, drops the query, and flags every dot segment', () => {
  assert.deepEqual(normalizePathname('/pair/abc?x=1#frag'), { pathname: '/pair/abc', suspicious: false });
  assert.deepEqual(normalizePathname('/pair/%61bc'), { pathname: '/pair/abc', suspicious: false });
  assert.equal(normalizePathname('/pair/%2e%2e/index.html').suspicious, true);
  assert.equal(normalizePathname('/pair/../index.html').suspicious, true);
  assert.equal(normalizePathname('/pair/./index.html').suspicious, true);

  assert.equal(normalizePathname('/pair/%252e%252e/index.html').suspicious, true);

  assert.equal(normalizePathname('/pair/%').suspicious, true);
});

test('a traversal dressed as a pair path is not a pair path', () => {
  assert.equal(isPairPath('/pair/%2e%2e/index.html'), false);
  assert.equal(isPairPath('/pair/../index.html'), false);
  assert.equal(isPairPath('/pair/%2e%2e%2findex.html'), false);
  assert.deepEqual(
    decideRequestAccess({
      remoteEnabled: true, trust: 'remote', pathname: normalizePathname('/pair/%2e%2e/index.html').pathname, authenticated: false, ownerOk: true,
    }),
    { allow: false, action: 'unauthorized' }
  );
});

const PATHS = ['/', '/hook/abc/Stop', '/agent/abc/spawn', '/app.js', '/pair/tok'];

test('with remote disabled every request is allowed on both listeners, whatever the path', () => {
  for (const trust of ['local', 'remote']) {
    for (const authenticated of [true, false]) {
      for (const pathname of PATHS) {
        assert.deepEqual(
          decideRequestAccess({ remoteEnabled: false, trust, pathname, authenticated }),
          { allow: true, action: 'allow' },
          `${trust}/${authenticated}/${pathname}`
        );
      }
    }
  }
});

test('with remote enabled the local listener stays fully open (byte-identical to today)', () => {
  for (const authenticated of [true, false]) {
    for (const pathname of PATHS) {
      assert.deepEqual(
        decideRequestAccess({ remoteEnabled: true, trust: 'local', pathname, authenticated }),
        { allow: true, action: 'allow' },
        `${authenticated}/${pathname}`
      );
    }
  }
});

test('on the remote listener only /pair/* is reachable without a cookie', () => {
  assert.deepEqual(
    decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname: '/pair/tok', authenticated: false, ownerOk: true }),
    { allow: true, action: 'pair-page' }
  );
  for (const pathname of ['/', '/app.js', '/hook/abc/Stop', '/agent/abc/spawn']) {
    assert.deepEqual(
      decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname, authenticated: false, ownerOk: true }),
      { allow: false, action: 'unauthorized' },
      pathname
    );
  }
});

test('the hook ingress is NOT exempt on the remote listener', () => {
  const decision = decideRequestAccess({
    remoteEnabled: true, trust: 'remote', pathname: '/hook/session/Stop', authenticated: false, ownerOk: true,
  });
  assert.equal(decision.allow, false);
});

test('the agent ingress is NOT exempt on the remote listener either', () => {
  for (const verb of ['spawn', 'attention', 'board']) {
    const decision = decideRequestAccess({
      remoteEnabled: true, trust: 'remote', pathname: `/agent/session/${verb}`, authenticated: false, ownerOk: true,
    });
    assert.equal(decision.allow, false, verb);
  }
});

test('an authenticated remote device reaches every path', () => {
  for (const pathname of PATHS) {
    assert.equal(
      decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname, authenticated: true, ownerOk: true }).allow,
      true,
      pathname
    );
  }
});

test('authenticated must be strictly true', () => {
  const decision = decideRequestAccess({
    remoteEnabled: true, trust: 'remote', pathname: '/', authenticated: 'yes', ownerOk: true,
  });
  assert.equal(decision.allow, false);
});

test('upgrade: a refused origin loses on both listeners, before any auth consideration', () => {
  for (const remoteEnabled of [false, true]) {
    for (const trust of ['local', 'remote']) {
      assert.deepEqual(
        decideUpgradeAccess({
          remoteEnabled, trust, origin: 'https://evil.example', allowedOrigins: ['https://glimmervoid.test'],
          authenticated: true,
        }),
        { allow: false, reason: 'origin' },
        `${remoteEnabled}/${trust}`
      );
    }
  }
});

test('upgrade: with remote disabled, an allowed origin passes without a cookie', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: false, trust: 'local', origin: 'http://localhost:3000', allowedOrigins: [], authenticated: false, listenerPorts: [3000] }),
    { allow: true, reason: null }
  );
});

test('upgrade: the local listener never needs a cookie even with remote enabled', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'local', origin: 'http://localhost:3000', allowedOrigins: ['https://glimmervoid.test'], authenticated: false, listenerPorts: [3000] }),
    { allow: true, reason: null }
  );
});

test('upgrade: a dashboard route needs an Origin and the page token', () => {
  const base = {
    remoteEnabled: false, trust: 'local', allowedOrigins: [], listenerPorts: [3000], dashboardRoute: true,
  };
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: 'http://localhost:3000', tokenOk: true }),
    { allow: true, reason: null }
  );
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: 'http://localhost:3000', tokenOk: false }),
    { allow: false, reason: 'token' }
  );
  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: undefined, tokenOk: true }),
    { allow: false, reason: 'origin' }
  );

  assert.deepEqual(
    decideUpgradeAccess({ ...base, origin: 'http://localhost:3000', tokenOk: 'yes' }),
    { allow: false, reason: 'token' }
  );
});

test('upgrade: a non-dashboard route still accepts a tokenless client with no Origin', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: false, trust: 'local', origin: undefined, allowedOrigins: [], listenerPorts: [3000] }),
    { allow: true, reason: null }
  );
});

test('upgrade: a paired remote device needs no page token (its cookie is the credential)', () => {
  assert.deepEqual(
    decideUpgradeAccess({
      remoteEnabled: true, trust: 'remote', origin: 'https://glimmervoid.test', allowedOrigins: ['https://glimmervoid.test'],
      authenticated: true, dashboardRoute: true, tokenOk: false,
    }),
    { allow: true, reason: null }
  );
});

test('upgrade: a remote socket needs both an allowed origin and a cookie', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: 'https://glimmervoid.test', allowedOrigins: ['https://glimmervoid.test'], authenticated: false }),
    { allow: false, reason: 'auth' }
  );
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: 'https://glimmervoid.test', allowedOrigins: ['https://glimmervoid.test'], authenticated: true }),
    { allow: true, reason: null }
  );
});

test('upgrade: a remote socket with no Origin header still needs a cookie', () => {
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: undefined, allowedOrigins: [], authenticated: false }),
    { allow: false, reason: 'auth' }
  );
  assert.deepEqual(
    decideUpgradeAccess({ remoteEnabled: true, trust: 'remote', origin: undefined, allowedOrigins: [], authenticated: true }),
    { allow: true, reason: null }
  );
});

test('the owner check is off when no owner login is configured', () => {
  for (const presentedLogin of [undefined, '', 'anyone@example.com', ['a@example.com']]) {
    assert.equal(decideOwnerAccess({ ownerLogin: '', presentedLogin }), true);
  }
});

test('only the configured Tailscale login passes the owner check, ignoring case and padding', () => {
  const ownerLogin = 'owner@example.com';
  assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin: 'owner@example.com' }), true);
  assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin: ' Owner@Example.com ' }), true);
  for (const presentedLogin of [undefined, '', 'intruder@example.com', 'owner@example.com, intruder@example.com', ['owner@example.com']]) {
    assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin }), false, JSON.stringify(presentedLogin));
  }
});

test('a non-ASCII owner login sent as a Tailscale Q-encoded word passes the owner check', () => {
  const ownerLogin = 'jörg@example.com';
  assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin: '=?utf-8?q?j=C3=B6rg@example.com?=' }), true);
  assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin: '=?UTF-8?Q?J=c3=b6rg@Example.com?=' }), true);
  assert.equal(decideOwnerAccess({ ownerLogin: 'jörg smith@example.com', presentedLogin: '=?utf-8?q?j=C3=B6rg_smith@example.com?=' }), true);
});

test('a malformed encoded word never passes the owner check', () => {
  const ownerLogin = 'jörg@example.com';
  for (const presentedLogin of [
    '=?utf-8?q?j=C3rg@example.com?=',
    '=?utf-8?q?j=ZZrg@example.com?=',
    '=?utf-8?q?j=C?=',
    '=?utf-8?b?asO2cmdAZXhhbXBsZS5jb20=?=',
    '=?iso-8859-1?q?j=F6rg@example.com?=',
  ]) {
    assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin }), false, presentedLogin);
  }
  const malformedWord = '=?utf-8?q?j=zzrg@example.com?=';
  assert.equal(decideOwnerAccess({ ownerLogin: malformedWord, presentedLogin: malformedWord }), false);
});

const GO_MAX_ENCODED_WORD_CONTENT_LENGTH = 75 - '=?utf-8?q?'.length - '?='.length;

function qEncodeRune(rune: string): string {
  return [...new TextEncoder().encode(rune)].map((byte) => {
    if (byte === 0x20) return '_';
    const isLiteral = byte >= 0x21 && byte <= 0x7e && byte !== 0x3d && byte !== 0x3f && byte !== 0x5f;
    if (isLiteral) return String.fromCharCode(byte);
    return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function qEncodeLikeTailscaleServe(login: string): string {
  const encodedWordContents = [''];
  for (const rune of login) {
    const encodedRune = qEncodeRune(rune);
    const currentContent = encodedWordContents[encodedWordContents.length - 1];
    if (currentContent.length + encodedRune.length > GO_MAX_ENCODED_WORD_CONTENT_LENGTH) {
      encodedWordContents.push(encodedRune);
      continue;
    }
    encodedWordContents[encodedWordContents.length - 1] = currentContent + encodedRune;
  }
  return encodedWordContents.map((content) => `=?utf-8?q?${content}?=`).join(' ');
}

test('a long non-ASCII owner login that Tailscale splits into several encoded words passes the owner check', () => {
  const ownerLogin = `${'a'.repeat(58)}ö@example.com`;
  const presentedLogin = qEncodeLikeTailscaleServe(ownerLogin);
  assert.ok(presentedLogin.split(' ').length > 1, presentedLogin);
  assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin }), true);
  assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin: presentedLogin.replace(' ', '\t  ') }), true);
});

test('a multi-word encoded login with a malformed word or trailing plain text never passes the owner check', () => {
  const ownerLogin = 'jörg@example.com';
  for (const presentedLogin of [
    '=?utf-8?q?j=C3=B6rg?= =?utf-8?q?@example=ZZcom?=',
    '=?utf-8?q?j=C3=B6rg?= =?utf-8?b?QGV4YW1wbGUuY29t?=',
    '=?utf-8?q?j=C3=B6rg?= =?iso-8859-1?q?@example.com?=',
    '=?utf-8?q?j=C3=B6rg?= @example.com',
    '=?utf-8?q?j=C3=B6rg?=@example.com',
    'j=?utf-8?q?=C3=B6rg@example.com?=',
  ]) {
    assert.equal(decideOwnerAccess({ ownerLogin, presentedLogin }), false, presentedLogin);
  }
});

test('a non-owner on the remote listener is refused before the pair exemption and before the cookie', () => {
  for (const pathname of PATHS) {
    for (const authenticated of [true, false]) {
      assert.deepEqual(
        decideRequestAccess({ remoteEnabled: true, trust: 'remote', pathname, authenticated, ownerOk: false }),
        { allow: false, action: 'not-owner' },
        `${authenticated}/${pathname}`
      );
    }
  }
});

test('the owner check never touches the local listener', () => {
  assert.deepEqual(
    decideRequestAccess({ remoteEnabled: true, trust: 'local', pathname: '/', authenticated: false, ownerOk: false }),
    { allow: true, action: 'allow' }
  );
});

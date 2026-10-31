import './support/disable-telemetry.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';

import { createBackend } from '../server/backend/backend.ts';
import { main as relayHook } from '../session/hook-relay.ts';
import type { Session } from '../session/sessions.ts';
import { closeServer, listen, prepareIsolatedEnvironment, removeHarnessTempDirectory } from './support/backend-harness.ts';

const MAX_ADDED_P50_MS = 5;
const WARMUP_CALLS = 50;
const MEASURED_CALLS = 400;
const CLAUDE_PROJECT_ID = 'hint-latency-claude';
const CODEX_PROJECT_ID = 'hint-latency-codex';

interface HookPath {
  label: string;
  session: Session;
  callHook: () => Promise<void>;
}

const TOOL_CALLS: readonly { label: string; payload: Record<string, unknown> }[] = [
  { label: 'Bash ls', payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: { stdout: 'a\nb' } } },
  { label: 'Write of a source file', payload: { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/src/index.ts', content: 'export {};' } } },
  { label: 'Bash writing an image', payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx playwright screenshot http://localhost out.png' } } },
];

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function timeOnce(call: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await call();
  return performance.now() - startedAt;
}

async function measureAddedLatency({ session, callHook }: HookPath): Promise<{ withLookupMs: number; withoutLookupMs: number }> {
  const realLookup = session.takeCommandHint.bind(session);
  const withLookup: number[] = [];
  const withoutLookup: number[] = [];
  const useLookup = (isOn: boolean) => {
    session.takeCommandHint = isOn ? realLookup : () => null;
  };
  for (let call = 0; call < WARMUP_CALLS; call += 1) await callHook();
  for (let call = 0; call < MEASURED_CALLS; call += 1) {
    const isLookupFirst = call % 2 === 0;
    useLookup(isLookupFirst);
    const firstMs = await timeOnce(callHook);
    useLookup(!isLookupFirst);
    const secondMs = await timeOnce(callHook);
    withLookup.push(isLookupFirst ? firstMs : secondMs);
    withoutLookup.push(isLookupFirst ? secondMs : firstMs);
  }
  useLookup(true);
  return { withLookupMs: median(withLookup), withoutLookupMs: median(withoutLookup) };
}

function claudeHookPath(base: string, session: Session, token: string, payload: Record<string, unknown>): () => Promise<void> {
  return async () => {
    const response = await fetch(`${base}/hook/${session.id}/PostToolUse?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
    await response.arrayBuffer();
  };
}

function codexRelayPath(base: string, session: Session, token: string, payload: Record<string, unknown>): () => Promise<void> {
  return async () => {
    await relayHook(['PostToolUse'], Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]), {
      GLIMMERVOID_HOOK_URL: `${base}/hook/${session.id}?t=${encodeURIComponent(token)}`,
    }, { write: () => {} });
  };
}

function hookTokenOf(session: Session): string {
  session._hooks.inject();
  const token = session._hooks.token();
  if (!token) throw new Error(`hook injection gave ${session.id} no token`);
  return token;
}

async function main(): Promise<number> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-hint-latency-'));
  const server = http.createServer();
  let backend: ReturnType<typeof createBackend> | null = null;
  try {
    const { port, configPath } = await prepareIsolatedEnvironment({ tempDirectory, repoRoots: [], recordSessions: false });
    const projectDirectory = path.join(tempDirectory, 'project');
    fs.mkdirSync(projectDirectory);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.projects = [
      { id: CLAUDE_PROJECT_ID, name: 'hint latency claude', path: projectDirectory },
      { id: CODEX_PROJECT_ID, name: 'hint latency codex', path: projectDirectory, agent: 'codex' },
    ];
    fs.writeFileSync(configPath, JSON.stringify(config));
    backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listen(server, port);
    const base = `http://127.0.0.1:${port}`;
    const claudeSession = backend.getSession(CLAUDE_PROJECT_ID);
    const codexSession = backend.getSession(CODEX_PROJECT_ID);
    if (!claudeSession || !codexSession) throw new Error('the isolated config did not create both sessions');
    const claudeToken = hookTokenOf(claudeSession);
    const codexToken = hookTokenOf(codexSession);
    const hookPaths: HookPath[] = TOOL_CALLS.flatMap(({ label, payload }) => [
      { label: `Claude PostToolUse http hook, ${label}`, session: claudeSession, callHook: claudeHookPath(base, claudeSession, claudeToken, payload) },
      { label: `Codex PostToolUse relay, ${label}`, session: codexSession, callHook: codexRelayPath(base, codexSession, codexToken, payload) },
    ]);
    let failedPaths = 0;
    for (const hookPath of hookPaths) {
      const { withLookupMs, withoutLookupMs } = await measureAddedLatency(hookPath);
      const addedMs = withLookupMs - withoutLookupMs;
      const isWithinBudget = addedMs <= MAX_ADDED_P50_MS;
      if (!isWithinBudget) failedPaths += 1;
      console.log(`${isWithinBudget ? 'PASS' : 'FAIL'}  ${hookPath.label}: p50 ${withLookupMs.toFixed(3)} ms with the hint lookup, ${withoutLookupMs.toFixed(3)} ms without, ${addedMs.toFixed(3)} ms added (budget ${MAX_ADDED_P50_MS} ms)`);
    }
    console.log('Codex runs its PostToolUse hint hook with async = true, so the relay above runs beside the tool call and never holds it.');
    return failedPaths === 0 ? 0 : 1;
  } finally {
    backend?.shutdown();
    await closeServer(server);
    removeHarnessTempDirectory(tempDirectory);
  }
}

process.exitCode = await main();

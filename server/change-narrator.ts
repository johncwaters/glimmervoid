import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHANGE_MAP_CLAIMS_MAX } from '../shared/contracts/change-map.ts';
import type { ChangeMap, ChangeNarrative } from '../shared/contracts/change-map.ts';
import { BrowserConfig, CHANGE_MAP_NARRATOR_ENGINES } from '../shared/contracts/config.ts';
import type { ChangeMapNarration, ChangeMapNarrator } from './change-map-wiring.ts';
import { createMemoryDistillSpawn, readDistillResultFile } from './memory-distill.ts';
import type { SpawnDistill } from './memory-distill.ts';
import {
  buildNarrativePrompt, factsHashInput, hasNarratableFacts, knownNarrativeFactIds, narrativeFacts, validateNarrative,
} from './core/change-narrative-core.ts';

const MAX_CACHED_HASHES = 64;
const PROMPT_FILE = 'change-narrative-prompt.txt';
const RESULT_FILE = 'change-narrative-result.json';
const SCHEMA_FILE = 'change-narrative-schema.json';
const BOOTSTRAP_PROMPT = `Read ${PROMPT_FILE} and follow its instructions`;
const CODEX_BOOTSTRAP_PROMPT = `Read ${PROMPT_FILE} in your cwd and answer only with the JSON`;
const CODEX_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['claims'],
  properties: { claims: {
    type: 'array', maxItems: CHANGE_MAP_CLAIMS_MAX,
    items: {
      type: 'object', additionalProperties: false, required: ['text', 'factIds'],
      properties: { text: { type: 'string' }, factIds: { type: 'array', items: { type: 'string' } } },
    },
  } },
};

type NarratorEngine = (typeof CHANGE_MAP_NARRATOR_ENGINES)[number];

interface SpawnNarrationOptions {
  map: ChangeMap;
  factsHash: string;
  engine: NarratorEngine;
  model: string;
  codexModel: string | null;
  timeoutSeconds: number;
}

type SpawnNarration = (options: SpawnNarrationOptions) => Promise<ChangeNarrative | null>;

interface ChangeNarratorOptions {
  getConfig: () => { changeMap?: unknown };
  spawnNarration?: SpawnNarration;
  spawnDistill?: SpawnDistill;
  nowFn?: () => number;
}

interface NarratorSettings {
  enabled?: boolean;
  engine?: NarratorEngine;
  model?: string;
  timeoutSeconds?: number;
}

interface RequestedNarration extends SpawnNarrationOptions {
  sessionId: string;
  onSettled: () => void;
}

interface NarrationLaunch {
  promptResultPath: string | null;
  bootstrapPrompt: string;
  agent: string | undefined;
  extraArgs: string[];
  model: string | null;
}

async function codexLaunch(workDir: string, resultPath: string, codexModel: string | null): Promise<NarrationLaunch> {
  const schemaPath = path.join(workDir, SCHEMA_FILE);
  await fs.writeFile(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA), 'utf8');
  return {
    promptResultPath: null,
    bootstrapPrompt: CODEX_BOOTSTRAP_PROMPT,
    agent: 'codex',
    extraArgs: [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', resultPath,
      ...(codexModel ? ['-m', codexModel] : []),
    ],
    model: null,
  };
}

function claudeLaunch(resultPath: string, model: string): NarrationLaunch {
  return { promptResultPath: resultPath, bootstrapPrompt: BOOTSTRAP_PROMPT, agent: undefined, extraArgs: [], model };
}

async function spawnNarrationWithSession({ map, factsHash, engine, model, codexModel, timeoutSeconds }: SpawnNarrationOptions, spawn: SpawnDistill, nowFn: () => number): Promise<ChangeNarrative | null> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-change-narrative-'));
  const promptPath = path.join(workDir, PROMPT_FILE);
  const resultPath = path.join(workDir, RESULT_FILE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  timeout.unref();
  try {
    const launch = engine === 'codex' ? await codexLaunch(workDir, resultPath, codexModel) : claudeLaunch(resultPath, model);
    await fs.writeFile(promptPath, buildNarrativePrompt({ facts: narrativeFacts(map), resultPath: launch.promptResultPath }), 'utf8');
    await spawn({
      id: `change-narrative:${nowFn()}:${crypto.randomUUID()}`,
      name: 'Change map narrative', cwd: workDir,
      prompt: launch.bootstrapPrompt, agent: launch.agent, extraArgs: launch.extraArgs, model: launch.model, signal: controller.signal,
    });
    if (controller.signal.aborted) return null;
    const raw = await readDistillResultFile(resultPath);
    return validateNarrative({ raw, knownFactIds: knownNarrativeFactIds(map), factsHash, model });
  } finally {
    clearTimeout(timeout);
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function createChangeNarrator({ getConfig, spawnNarration, spawnDistill = createMemoryDistillSpawn(), nowFn = () => Date.now() }: ChangeNarratorOptions): ChangeMapNarrator {
  const runNarration = spawnNarration ?? ((request: SpawnNarrationOptions) => spawnNarrationWithSession(request, spawnDistill, nowFn));
  const cachedByHash = new Map<string, ChangeNarrative | null>();
  const queuedBySessionId = new Map<string, RequestedNarration>();
  let active: { factsHash: string; callbacksBySessionId: Map<string, () => void> } | null = null;

  function narratorSettings() {
    const parsed = BrowserConfig.shape.changeMap.safeParse(getConfig().changeMap);
    if (!parsed.success) return null;
    return (parsed.data?.narrator ?? null) as NarratorSettings | null;
  }

  function cache(factsHash: string, narrative: ChangeNarrative | null): void {
    cachedByHash.delete(factsHash);
    cachedByHash.set(factsHash, narrative);
    if (cachedByHash.size <= MAX_CACHED_HASHES) return;
    const oldestHash = cachedByHash.keys().next().value;
    if (oldestHash) cachedByHash.delete(oldestHash);
  }

  function start(request: RequestedNarration): void {
    const callbacksBySessionId = new Map([[request.sessionId, request.onSettled]]);
    active = { factsHash: request.factsHash, callbacksBySessionId };
    void Promise.resolve().then(() => runNarration(request)).then(
      (narrative) => finish(request.factsHash, narrative),
      () => finish(request.factsHash, null),
    );
  }

  function startNext(): void {
    if (active) return;
    for (const [sessionId, request] of queuedBySessionId) {
      queuedBySessionId.delete(sessionId);
      if (!narratorSettings()?.enabled || cachedByHash.has(request.factsHash)) {
        request.onSettled();
        continue;
      }
      start(request);
      break;
    }
  }

  function finish(factsHash: string, narrative: ChangeNarrative | null): void {
    if (!active || active.factsHash !== factsHash) return;
    const callbacks = [...active.callbacksBySessionId.values()];
    cache(factsHash, narrative);
    active = null;
    startNext();
    for (const callback of callbacks) callback();
  }

  function narrationFor(map: ChangeMap, onSettled: () => void, { mayStart = true }: { mayStart?: boolean } = {}): ChangeMapNarration {
    const config = narratorSettings();
    if (!config?.enabled || !hasNarratableFacts(map)) {
      queuedBySessionId.delete(map.sessionId);
      return { narrative: null, narratorState: 'disabled' };
    }
    const engine = config.engine ?? 'claude';
    const configuredModel = config.model?.trim() || '';
    const model = configuredModel || (engine === 'claude' ? 'haiku' : 'codex default');
    const factsHash = crypto.createHash('sha256').update(JSON.stringify([factsHashInput(map), engine, configuredModel])).digest('hex');
    if (cachedByHash.has(factsHash)) {
      queuedBySessionId.delete(map.sessionId);
      const narrative = cachedByHash.get(factsHash) ?? null;
      return { narrative, narratorState: narrative ? 'ready' : 'failed' };
    }
    if (active?.factsHash === factsHash) {
      active.callbacksBySessionId.set(map.sessionId, onSettled);
      queuedBySessionId.delete(map.sessionId);
      return { narrative: null, narratorState: 'pending' };
    }
    if (!mayStart) return { narrative: null, narratorState: queuedBySessionId.has(map.sessionId) ? 'pending' : 'disabled' };
    const request: RequestedNarration = {
      map, factsHash, sessionId: map.sessionId, onSettled,
      engine, model, codexModel: engine === 'codex' ? configuredModel || null : null,
      timeoutSeconds: config.timeoutSeconds ?? 90,
    };
    if (active) {
      queuedBySessionId.set(map.sessionId, request);
      return { narrative: null, narratorState: 'pending' };
    }
    start(request);
    return { narrative: null, narratorState: 'pending' };
  }

  return { narrationFor };
}

export { createChangeNarrator };
export type { ChangeNarratorOptions, SpawnNarration, SpawnNarrationOptions };

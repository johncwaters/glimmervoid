import { type AgentName, createRecorder, launchAgent, loadSdk, type Recorder, tappedStreams } from './acp-client.ts';

export type JsonObject = Record<string, unknown>;

export type PermissionPolicy = 'allow_once' | 'reject_once' | 'cancelled';

export type ObservedRequest = { method: string; params: JsonObject; answer: JsonObject };

export type PromptOutcome = { stopReason: string | null; error: string | null; agentText: string; updateKinds: string[]; durationMs: number };

export type AgentSession = {
  agent: AgentName;
  initializeResult: JsonObject;
  recorder: Recorder;
  updates: JsonObject[];
  observedRequests: ObservedRequest[];
  request: (method: string, params: JsonObject, timeoutMs?: number) => Promise<JsonObject>;
  notify: (method: string, params: JsonObject) => Promise<void>;
  prompt: (sessionId: string, text: string, options?: { timeoutMs?: number; onUpdate?: (update: JsonObject) => void }) => Promise<PromptOutcome>;
  setPermissionPolicy: (policy: PermissionPolicy) => void;
  kill: () => Promise<void>;
  stderrTail: () => string[];
};

export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
  subagents: {},
};

const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function chooseOption(options: JsonObject[], policy: PermissionPolicy): JsonObject {
  if (policy === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  const wantedKind = policy === 'allow_once' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const matching = wantedKind.map((kind) => options.find((option) => option.kind === kind)).find((option) => option !== undefined);
  const chosen = matching ?? options[0];
  if (chosen === undefined) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
}

export function acceptSecondChoice(request: JsonObject): JsonObject {
  const schema = (request.requestedSchema ?? {}) as JsonObject;
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  const content: JsonObject = {};
  for (const [name, property] of Object.entries(properties)) {
    const enumValues = (property.enum ?? (property.items as JsonObject | undefined)?.enum) as unknown[] | undefined;
    const oneOf = (property.oneOf ?? (property.items as JsonObject | undefined)?.anyOf) as JsonObject[] | undefined;
    const choices = enumValues ?? oneOf?.map((option) => option.const);
    if (choices === undefined || choices.length === 0) continue;
    const secondValue = choices[Math.min(1, choices.length - 1)];
    content[name] = property.type === 'array' ? [secondValue] : secondValue;
  }
  return { action: 'accept', content };
}

export async function openAgentSession(agent: AgentName, cwd: string, recordingPath: string): Promise<AgentSession> {
  const sdk = await loadSdk();
  const recorder = createRecorder(recordingPath);
  const launched = launchAgent(agent, cwd, recorder);
  const updates: JsonObject[] = [];
  const observedRequests: ObservedRequest[] = [];
  const updateListeners = new Set<(update: JsonObject) => void>();
  let permissionPolicy: PermissionPolicy = 'allow_once';

  const app = sdk
    .client({ name: 'glimmervoid-acp-spike' })
    .onNotification('session/update', ({ params }: { params: JsonObject }) => {
      updates.push(params);
      for (const listener of updateListeners) listener(params);
    })
    .onRequest('session/request_permission', ({ params }: { params: JsonObject }) => {
      const answer = chooseOption((params.options ?? []) as JsonObject[], permissionPolicy);
      observedRequests.push({ method: 'session/request_permission', params, answer });
      return answer;
    })
    .onRequest('elicitation/create', ({ params }: { params: JsonObject }) => {
      const answer = acceptSecondChoice(params);
      observedRequests.push({ method: 'elicitation/create', params, answer });
      return answer;
    })
    .onRequest('*', ({ method, params }: { method: string; params: JsonObject }) => {
      observedRequests.push({ method, params, answer: { error: 'not supported by spike client' } });
      throw new sdk.RequestError(-32601, `spike client does not implement ${method}`);
    });

  const connection = app.connect(sdk.ndJsonStream(...Object.values(tappedStreams(launched, recorder))));
  const request = (method: string, params: JsonObject, timeoutMs = 120_000) =>
    withTimeout(connection.agent.request(method, params) as Promise<JsonObject>, timeoutMs, method);
  const notify = (method: string, params: JsonObject) => connection.agent.notify(method, params) as Promise<void>;

  const initializeResult = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: CLIENT_CAPABILITIES,
    clientInfo: { name: 'glimmervoid-acp-spike', version: '0.0.0' },
  });

  const prompt: AgentSession['prompt'] = async (sessionId, text, options = {}) => {
    const startedAtMs = Date.now();
    const kinds: string[] = [];
    let agentText = '';
    const listener = (notification: JsonObject) => {
      if (notification.sessionId !== sessionId) return;
      const update = notification.update as JsonObject;
      kinds.push(String(update.sessionUpdate));
      if (update.sessionUpdate === 'agent_message_chunk') agentText += String((update.content as JsonObject | undefined)?.text ?? '');
      options.onUpdate?.(update);
    };
    updateListeners.add(listener);
    try {
      const response = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
      return { stopReason: String(response.stopReason ?? null), error: null, agentText, updateKinds: kinds, durationMs: Date.now() - startedAtMs };
    } catch (error) {
      return { stopReason: null, error: error instanceof Error ? error.message : JSON.stringify(error), agentText, updateKinds: kinds, durationMs: Date.now() - startedAtMs };
    } finally {
      updateListeners.delete(listener);
    }
  };

  const kill = async () => {
    recorder.note(`kill pid=${launched.child.pid}`);
    if (launched.child.pid !== undefined) process.kill(-launched.child.pid, 'SIGKILL');
    await withTimeout(launched.exited, 10_000, 'agent exit').catch(() => undefined);
  };

  return {
    agent,
    initializeResult,
    recorder,
    updates,
    observedRequests,
    request,
    notify,
    prompt,
    setPermissionPolicy: (policy) => {
      permissionPolicy = policy;
    },
    kill,
    stderrTail: () => launched.stderrLines.slice(-30),
  };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { ClientConnection, CreateElicitationResponse, McpServer, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import { spawn } from "../../server/child-process-safe.ts";
import { glimmervoidHomeDir } from "../../server/core/config-path-core.ts";
import { errorMessage } from "../../shared/text.ts";
import {
  CODEX_HOOKS_LIST_METHOD,
  CODEX_HOOKS_TRUST_METHOD,
  acpCodexProviderConfigFor,
  acpCodexSaneYoloEnvFor,
  acpPackSystemPromptFor,
  acpSaneYoloMetaFor,
  acpSessionMetaFor,
  acpSpawnEnvFor,
  classifyAcpPromptError,
  decideAcpSend,
  doesUpdateConfirmPrompt,
  findCodexSaneYoloHook,
  initializeRequestFor,
  isAcpSaneYoloCovered,
  isCodexHooksTrustConfirmed,
  openingModePlanFor,
  permissionFieldsOf,
  planAcpConfigOption,
  planSessionOpen,
  questionFieldsOf,
  supportsAcpSystemPrompt,
  wantedAcpConfigValues,
} from "../core/acp-driver-core.ts";
import type { AcpPhase } from "../core/acp-driver-core.ts";
import type { ResolvedHookTool } from "../core/hook-tools.ts";
import type { DeliverOptions, DeliveryOutcome } from "../core/input-delivery-core.ts";
import type { DriverEvent, DriverFailureStage, DriverLaunch, DriverListener, SessionDriver } from "./driver.ts";

interface AcpDriverOptions {
  clientName: string;
  clientVersion: string;
  mcpServers: McpServer[];
  killTree: (pid: number, scopeUnit: string | null) => void;
  agentId?: string;
  saneYolo?: () => { tool: ResolvedHookTool; homeDir: string } | null;
  onSaneYoloCoverageChange?: (isCovered: boolean) => void;
}

interface ActivePrompt {
  text: string;
  options: DeliverOptions;
  isConfirmed: boolean;
}

function signalNumberOf(signalName: NodeJS.Signals | null): number | undefined {
  if (signalName === null) return undefined;
  return os.constants.signals[signalName];
}

function dropAccountPrivateExtensionNotification(): void {}

const ACP_SPAWN_DIR_MODE = 0o700;

function ensureAcpSpawnCwd(): string {
  const spawnCwd = path.join(glimmervoidHomeDir(os.homedir(), process.env), "acp");
  fs.mkdirSync(spawnCwd, { recursive: true, mode: ACP_SPAWN_DIR_MODE });
  return spawnCwd;
}

function createAcpDriver(options: AcpDriverOptions): SessionDriver {
  const listeners = new Set<DriverListener>();
  let child: ChildProcess | null = null;
  let scopeUnit: string | null = null;
  let connection: ClientConnection | null = null;
  let phase: AcpPhase = "idle";
  let agentSessionId: string | null = null;
  let isPromptOpen = false;
  let activePrompt: ActivePrompt | null = null;
  let runGeneration = 0;

  function emit(event: DriverEvent): void {
    for (const listener of listeners) listener(event);
  }

  function reportFailure(generation: number, stage: DriverFailureStage, error: unknown): void {
    if (generation !== runGeneration || phase === "closed") return;
    emit({ kind: "failure", stage, message: errorMessage(error) });
  }

  function confirmActivePrompt(): void {
    if (activePrompt === null || activePrompt.isConfirmed || agentSessionId === null) return;
    activePrompt.isConfirmed = true;
    emit({ kind: "prompt", agentSessionId, text: activePrompt.text });
    activePrompt.options.onSettled?.("submitted");
  }

  function dropActivePrompt(detail?: string): void {
    const pending = activePrompt;
    activePrompt = null;
    if (pending === null || pending.isConfirmed) return;
    pending.options.onSettled?.("dropped", detail);
  }

  function openPrompt(generation: number, activeConnection: ClientConnection, sessionId: string, text: string, deliverOptions: DeliverOptions): void {
    isPromptOpen = true;
    activePrompt = { text, options: deliverOptions, isConfirmed: false };
    const turn = activeConnection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
    turn.then(
      (response) => {
        if (generation !== runGeneration || phase === "closed") return;
        confirmActivePrompt();
        activePrompt = null;
        isPromptOpen = false;
        emit({ kind: "turn-end", stopReason: response.stopReason });
      },
      (error: unknown) => {
        if (generation !== runGeneration || phase === "closed") return;
        const decision = classifyAcpPromptError({
          isRequestError: error instanceof RequestError,
          isConnectionAlive: phase === "ready",
          message: errorMessage(error),
        });
        isPromptOpen = false;
        dropActivePrompt(decision.failureMessage ?? undefined);
        if (decision.action === "end-turn") {
          emit({ kind: "prompt-error", message: decision.failureMessage });
          return;
        }
        reportFailure(generation, "prompt", error);
      },
    );
  }

  async function trustCodexSaneYoloHook(activeConnection: ClientConnection, cwd: string, hookCommand: string): Promise<boolean> {
    try {
      const listed = await activeConnection.agent.request(CODEX_HOOKS_LIST_METHOD, { cwd });
      const matched = findCodexSaneYoloHook(listed, hookCommand);
      if (matched === null) {
        console.warn("[acp-driver] Codex did not list the Sane YOLO hook as an enabled session flag; reporting Sane YOLO off");
        return false;
      }
      if (matched.isTrusted) return true;
      const trustResult = await activeConnection.agent.request(CODEX_HOOKS_TRUST_METHOD, {
        cwd,
        hooks: [{ key: matched.key, currentHash: matched.currentHash }],
      });
      if (isCodexHooksTrustConfirmed(trustResult)) return true;
      console.warn("[acp-driver] Codex did not confirm trust for the Sane YOLO hook; reporting Sane YOLO off");
      return false;
    } catch (error: unknown) {
      console.warn(`[acp-driver] failed to trust Codex Sane YOLO hook: ${errorMessage(error)}`);
      return false;
    }
  }

  async function applyOpeningConfigOptions(
    generation: number,
    activeConnection: ClientConnection,
    sessionId: string,
    agentId: string,
    initialConfigOptions: unknown,
    modelSelection: DriverLaunch["modelSelection"],
  ): Promise<void> {
    const wanted = wantedAcpConfigValues(agentId, modelSelection);
    let currentConfigOptions = initialConfigOptions;
    const steps: readonly { category: "model" | "thought_level"; wantedValue: string | null }[] = [
      { category: "model", wantedValue: wanted.model },
      { category: "thought_level", wantedValue: wanted.effort },
    ];
    for (const { category, wantedValue } of steps) {
      if (generation !== runGeneration || phase !== "opening") return;
      const plan = planAcpConfigOption(currentConfigOptions, category, wantedValue);
      if (plan.kind === "skip") continue;
      if (plan.kind === "warn") {
        console.warn(`[acp-driver] ${plan.message}`);
        continue;
      }
      try {
        const updated = await activeConnection.agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: plan.configId,
          value: plan.value,
        });
        if (typeof updated === "object" && updated !== null && "configOptions" in updated && Array.isArray(updated.configOptions)) {
          currentConfigOptions = updated.configOptions;
        }
      } catch (error: unknown) {
        console.warn(`[acp-driver] failed to set ${category} option "${plan.configId}" to "${plan.value}" on ${agentId}: ${errorMessage(error)}`);
      }
    }
  }

  async function openSession(
    generation: number,
    activeConnection: ClientConnection,
    launch: DriverLaunch,
    saneYoloConfig: { tool: ResolvedHookTool; homeDir: string } | null,
    codexHookCommand: string | null,
  ): Promise<void> {
    const initialized = await activeConnection.agent.request(methods.agent.initialize, initializeRequestFor(PROTOCOL_VERSION, options.clientName, options.clientVersion));
    const agentId = options.agentId ?? "";
    const hasClaudeSaneYoloMeta = acpSaneYoloMetaFor(agentId, saneYoloConfig?.tool, saneYoloConfig?.homeDir ?? "") !== undefined;
    const sessionMeta = acpSessionMetaFor({
      agentId,
      saneYoloTool: saneYoloConfig?.tool,
      saneYoloHomeDir: saneYoloConfig?.homeDir,
      isCleanHome: launch.isCleanHome,
      claudePluginDirs: launch.claudePluginDirs,
    });
    const hasSystemPromptSupport = supportsAcpSystemPrompt(initialized);
    const systemPrompt = acpPackSystemPromptFor(launch.packContextLines, hasSystemPromptSupport);
    if ((launch.packContextLines?.length ?? 0) > 0 && !hasSystemPromptSupport) {
      console.warn(`[acp-driver] ${agentId} does not advertise sessionCapabilities.systemPrompt; skipping pack context`);
    }
    const plan = planSessionOpen(PROTOCOL_VERSION, initialized, launch.cwd, launch.mcpServers ?? options.mcpServers, launch.resumeAgentSessionId, sessionMeta, systemPrompt);
    if (plan.method === "refuse") throw new Error(plan.message);
    if (generation !== runGeneration || phase !== "opening") return;
    const isCodexHookTrusted = codexHookCommand !== null
      ? await trustCodexSaneYoloHook(activeConnection, launch.cwd, codexHookCommand)
      : false;
    if (generation !== runGeneration || phase !== "opening") return;
    const opened = plan.method === "session/load"
      ? await activeConnection.agent.request(methods.agent.session.load, plan.request)
      : await activeConnection.agent.request(methods.agent.session.new, plan.request);
    const openedSessionId = plan.method === "session/load" ? plan.request.sessionId : (opened as { sessionId?: unknown }).sessionId;
    if (typeof openedSessionId !== "string" || openedSessionId.length === 0) {
      throw new Error("the ACP agent returned an invalid session id");
    }
    const openedConfigOptions = typeof opened === "object" && opened !== null && "configOptions" in opened ? opened.configOptions : undefined;
    await applyOpeningConfigOptions(generation, activeConnection, openedSessionId, agentId, openedConfigOptions, launch.modelSelection);
    if (generation !== runGeneration || phase !== "opening") return;
    const openedModes = typeof opened === "object" && opened !== null && "modes" in opened ? opened.modes : undefined;
    const modePlan = openingModePlanFor(agentId, saneYoloConfig !== null, openedModes);
    const modeOutcome = modePlan.kind === "set-mode"
      ? await activeConnection.agent.request(methods.agent.session.setMode, { sessionId: openedSessionId, modeId: modePlan.modeId })
        .then(() => "confirmed" as const)
        .catch((error: unknown) => {
          console.warn(`[acp-driver] failed to set mode "${modePlan.modeId}" on ${agentId}: ${errorMessage(error)}`);
          return "unconfirmed" as const;
        })
      : modePlan.kind === "already-asking" ? "confirmed" as const : "unconfirmed" as const;
    if (generation !== runGeneration || phase !== "opening") return;
    agentSessionId = openedSessionId;
    phase = "ready";
    const hasHookConfig = agentId === "codex" ? codexHookCommand !== null : hasClaudeSaneYoloMeta;
    const isConfirmed = agentId === "codex" ? isCodexHookTrusted : modeOutcome === "confirmed";
    options.onSaneYoloCoverageChange?.(isAcpSaneYoloCovered(agentId, saneYoloConfig !== null, hasHookConfig, isConfirmed));
    emit({ kind: "agent-session", agentSessionId: openedSessionId, isResumed: plan.method === "session/load" });
  }

  function connect(generation: number, agentProcess: ChildProcess): ClientConnection {
    if (!agentProcess.stdin || !agentProcess.stdout) throw new Error("the ACP agent process has no stdio pipes");
    agentProcess.stdin.on("error", () => {});
    const toAgent = Writable.toWeb(agentProcess.stdin) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(agentProcess.stdout) as ReadableStream<Uint8Array>;
    return client({ name: options.clientName })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (generation !== runGeneration || phase === "closed") return;
        if (isPromptOpen && doesUpdateConfirmPrompt(params.update)) confirmActivePrompt();
        emit({ kind: "update", agentSessionId: params.sessionId, update: params.update });
      })
      .onNotification("*", dropAccountPrivateExtensionNotification)
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => new Promise<RequestPermissionResponse>((resolve) => {
        if (generation !== runGeneration || phase === "closed") return resolve({ outcome: { outcome: "cancelled" } });
        if (isPromptOpen) confirmActivePrompt();
        emit({ kind: "permission", request: { ...permissionFieldsOf(params), options: params.options, withdrawn: signal, respond: (outcome) => resolve({ outcome }) } });
      }))
      .onRequest(methods.client.elicitation.create, ({ params, signal }) => new Promise<CreateElicitationResponse>((resolve) => {
        if (generation !== runGeneration || phase === "closed") return resolve({ action: "cancel" });
        const fields = questionFieldsOf(params);
        if (fields === null) return resolve({ action: "decline" });
        if (isPromptOpen) confirmActivePrompt();
        emit({ kind: "question", question: { ...fields, withdrawn: signal, respond: (answer) => resolve(answer as CreateElicitationResponse) } });
      }))
      .connect(ndJsonStream(toAgent, fromAgent));
  }

  function start(launch: DriverLaunch): void {
    const spawnCwd = ensureAcpSpawnCwd();
    if (child !== null && child.pid !== undefined && (phase === "opening" || phase === "ready")) {
      options.killTree(child.pid, scopeUnit);
    }
    const generation = ++runGeneration;
    agentSessionId = null;
    isPromptOpen = false;
    options.onSaneYoloCoverageChange?.(false);
    dropActivePrompt();
    const saneYoloConfig = options.saneYolo?.() ?? null;
    const baseEnv = acpSpawnEnvFor(launch.env, launch.sessionEnv);
    const codexProviderConfig = acpCodexProviderConfigFor(options.agentId ?? "", launch.modelSelection, process.platform);
    const codexSaneYolo = acpCodexSaneYoloEnvFor(baseEnv, options.agentId ?? "", saneYoloConfig?.tool, saneYoloConfig?.homeDir ?? "", codexProviderConfig);
    if (codexSaneYolo.warning) console.warn(`[acp-driver] ${codexSaneYolo.warning}`);
    const agentProcess = spawn(launch.file, launch.args, {
      cwd: spawnCwd,
      env: codexSaneYolo.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = agentProcess;
    scopeUnit = launch.scopeUnit;
    phase = "opening";
    agentProcess.stderr?.resume();
    agentProcess.on("error", (error) => {
      if (generation !== runGeneration) return;
      reportFailure(generation, "open", error);
      phase = "closed";
    });
    const activeConnection = connect(generation, agentProcess);
    connection = activeConnection;
    agentProcess.on("exit", () => {
      if (generation !== runGeneration || scopeUnit === null || agentProcess.pid === undefined) return;
      options.killTree(agentProcess.pid, scopeUnit);
    });
    agentProcess.on("close", (exitCode, signalName) => {
      if (generation !== runGeneration) return;
      phase = "closed";
      isPromptOpen = false;
      options.onSaneYoloCoverageChange?.(false);
      dropActivePrompt();
      void activeConnection.closed.then(() => {
        if (generation !== runGeneration) return;
        emit({ kind: "exit", exitCode: exitCode ?? 0, signal: signalNumberOf(signalName) });
      });
    });
    openSession(generation, activeConnection, launch, saneYoloConfig, codexSaneYolo.hookCommand).catch((error: unknown) => {
      if (generation !== runGeneration) return;
      reportFailure(generation, "open", error);
      stop();
    });
  }

  function send(text: string, deliverOptions: DeliverOptions): DeliveryOutcome {
    const decision = decideAcpSend({ phase, isPromptOpen }, deliverOptions);
    if (decision.action === "prompt" && connection !== null && agentSessionId !== null) {
      openPrompt(runGeneration, connection, agentSessionId, text, deliverOptions);
    }
    return decision.outcome;
  }

  function interrupt(): void {
    if (!isPromptOpen || connection === null || agentSessionId === null) return;
    const generation = runGeneration;
    connection.agent.notify(methods.agent.session.cancel, { sessionId: agentSessionId }).catch((error: unknown) => reportFailure(generation, "prompt", error));
  }

  function stop(): boolean {
    if (child === null || child.pid === undefined) return false;
    phase = "closed";
    isPromptOpen = false;
    options.onSaneYoloCoverageChange?.(false);
    dropActivePrompt();
    options.killTree(child.pid, scopeUnit);
    return true;
  }

  return {
    hasTerminal: false,
    get pid() { return child?.pid ?? null; },
    get scopeUnit() { return scopeUnit; },
    get isLive() { return phase === "opening" || phase === "ready"; },
    start,
    send,
    interrupt,
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export { createAcpDriver };

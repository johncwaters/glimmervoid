import os from "node:os";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ClientConnection, CreateElicitationResponse, McpServer, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import { spawn } from "../../server/child-process-safe.ts";
import { errorMessage } from "../../shared/text.ts";
import { decideAcpSend, initializeRequestFor, permissionFieldsOf, planSessionOpen, questionFieldsOf } from "../core/acp-driver-core.ts";
import type { AcpPhase } from "../core/acp-driver-core.ts";
import type { DeliverOptions, DeliveryOutcome } from "../core/input-delivery-core.ts";
import { withoutGlimmervoidSecrets } from "../core/spawn-env.ts";
import type { DriverEvent, DriverFailureStage, DriverLaunch, DriverListener, SessionDriver } from "./driver.ts";

interface AcpDriverOptions {
  clientName: string;
  clientVersion: string;
  mcpServers: McpServer[];
  killTree: (pid: number) => void;
}

interface QueuedPrompt {
  text: string;
  options: DeliverOptions;
}

function signalNumberOf(signalName: NodeJS.Signals | null): number | undefined {
  if (signalName === null) return undefined;
  return os.constants.signals[signalName];
}

function dropAccountPrivateExtensionNotification(): void {}

function createAcpDriver(options: AcpDriverOptions): SessionDriver {
  const listeners = new Set<DriverListener>();
  let child: ChildProcess | null = null;
  let connection: ClientConnection | null = null;
  let phase: AcpPhase = "idle";
  let agentSessionId: string | null = null;
  let isPromptOpen = false;
  let queuedPrompt: QueuedPrompt | null = null;
  let runGeneration = 0;

  function emit(event: DriverEvent): void {
    for (const listener of listeners) listener(event);
  }

  function reportFailure(generation: number, stage: DriverFailureStage, error: unknown): void {
    if (generation !== runGeneration || phase === "closed") return;
    emit({ kind: "failure", stage, message: errorMessage(error) });
  }

  function dropQueuedPrompt(): void {
    queuedPrompt?.options.onSettled?.("dropped");
    queuedPrompt = null;
  }

  function openPrompt(generation: number, activeConnection: ClientConnection, sessionId: string, prompt: QueuedPrompt): void {
    isPromptOpen = true;
    const turn = activeConnection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: prompt.text }] });
    prompt.options.onSettled?.("submitted");
    turn.then(
      (response) => {
        if (generation !== runGeneration || phase === "closed") return;
        isPromptOpen = false;
        emit({ kind: "turn-end", stopReason: response.stopReason });
      },
      (error: unknown) => {
        if (generation !== runGeneration || phase === "closed") return;
        isPromptOpen = false;
        reportFailure(generation, "prompt", error);
      },
    );
  }

  async function openSession(generation: number, activeConnection: ClientConnection, launch: DriverLaunch): Promise<void> {
    const initialized = await activeConnection.agent.request(methods.agent.initialize, initializeRequestFor(PROTOCOL_VERSION, options.clientName, options.clientVersion));
    const plan = planSessionOpen(PROTOCOL_VERSION, initialized, launch.cwd, options.mcpServers, launch.resumeAgentSessionId);
    if (plan.method === "refuse") throw new Error(plan.message);
    if (plan.method === "session/load") await activeConnection.agent.request(methods.agent.session.load, plan.request);
    const openedSessionId = plan.method === "session/load"
      ? plan.request.sessionId
      : (await activeConnection.agent.request(methods.agent.session.new, plan.request)).sessionId;
    if (typeof openedSessionId !== "string" || openedSessionId.length === 0) {
      throw new Error("the ACP agent returned an invalid session id");
    }
    if (generation !== runGeneration || phase !== "opening") return;
    agentSessionId = openedSessionId;
    phase = "ready";
    emit({ kind: "agent-session", agentSessionId: openedSessionId, isResumed: plan.method === "session/load" });
    const waitingPrompt = queuedPrompt;
    queuedPrompt = null;
    if (waitingPrompt !== null) openPrompt(generation, activeConnection, openedSessionId, waitingPrompt);
  }

  function connect(generation: number, agentProcess: ChildProcess): ClientConnection {
    if (!agentProcess.stdin || !agentProcess.stdout) throw new Error("the ACP agent process has no stdio pipes");
    agentProcess.stdin.on("error", () => {});
    const toAgent = Writable.toWeb(agentProcess.stdin) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(agentProcess.stdout) as ReadableStream<Uint8Array>;
    return client({ name: options.clientName })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (generation !== runGeneration || phase === "closed") return;
        emit({ kind: "update", agentSessionId: params.sessionId, update: params.update });
      })
      .onNotification("*", dropAccountPrivateExtensionNotification)
      .onRequest(methods.client.session.requestPermission, ({ params }) => new Promise<RequestPermissionResponse>((resolve) => {
        if (generation !== runGeneration || phase === "closed") return resolve({ outcome: { outcome: "cancelled" } });
        emit({ kind: "permission", request: { ...permissionFieldsOf(params), options: params.options, respond: (outcome) => resolve({ outcome }) } });
      }))
      .onRequest(methods.client.elicitation.create, ({ params }) => new Promise<CreateElicitationResponse>((resolve) => {
        if (generation !== runGeneration || phase === "closed") return resolve({ action: "cancel" });
        const fields = questionFieldsOf(params);
        if (fields === null) return resolve({ action: "decline" });
        emit({ kind: "question", question: { ...fields, respond: (answer) => resolve(answer as CreateElicitationResponse) } });
      }))
      .connect(ndJsonStream(toAgent, fromAgent));
  }

  function start(launch: DriverLaunch): void {
    if (child !== null && child.pid !== undefined && (phase === "opening" || phase === "ready")) {
      options.killTree(child.pid);
    }
    const generation = ++runGeneration;
    agentSessionId = null;
    isPromptOpen = false;
    dropQueuedPrompt();
    const agentProcess = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: withoutGlimmervoidSecrets(launch.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = agentProcess;
    phase = "opening";
    agentProcess.stderr?.resume();
    agentProcess.on("error", (error) => {
      if (generation !== runGeneration) return;
      reportFailure(generation, "open", error);
      phase = "closed";
    });
    const activeConnection = connect(generation, agentProcess);
    connection = activeConnection;
    agentProcess.on("close", (exitCode, signalName) => {
      if (generation !== runGeneration) return;
      phase = "closed";
      isPromptOpen = false;
      dropQueuedPrompt();
      void activeConnection.closed.then(() => {
        if (generation !== runGeneration) return;
        emit({ kind: "exit", exitCode: exitCode ?? 0, signal: signalNumberOf(signalName) });
      });
    });
    openSession(generation, activeConnection, launch).catch((error: unknown) => {
      if (generation !== runGeneration) return;
      reportFailure(generation, "open", error);
      stop();
    });
  }

  function send(text: string, deliverOptions: DeliverOptions): DeliveryOutcome {
    const decision = decideAcpSend({ phase, isPromptOpen, hasQueuedPrompt: queuedPrompt !== null }, deliverOptions);
    if (decision.action === "queue") queuedPrompt = { text, options: deliverOptions };
    if (decision.action === "prompt" && connection !== null && agentSessionId !== null) {
      openPrompt(runGeneration, connection, agentSessionId, { text, options: deliverOptions });
    }
    return decision.outcome;
  }

  function interrupt(): void {
    dropQueuedPrompt();
    if (!isPromptOpen || connection === null || agentSessionId === null) return;
    const generation = runGeneration;
    connection.agent.notify(methods.agent.session.cancel, { sessionId: agentSessionId }).catch((error: unknown) => reportFailure(generation, "prompt", error));
  }

  function stop(): boolean {
    if (child === null || child.pid === undefined) return false;
    phase = "closed";
    isPromptOpen = false;
    dropQueuedPrompt();
    options.killTree(child.pid);
    return true;
  }

  return {
    hasTerminal: false,
    get pid() { return child?.pid ?? null; },
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

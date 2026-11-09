import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createBackend } from "../server/backend/backend.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { closeServer, createProbeChecks, delay, hookEventsOf, waitForState, writeHookFixture } from "./support/backend-harness.ts";
import type { ProbeFixtureTarget, ProbeHookRecord } from "./support/backend-harness.ts";

interface StubModelStep {
  text?: string;
  shellCommand?: string;
}

interface ScriptedPrompt {
  prompt: string;
  firstReply: StubModelStep;
}

interface StubModel {
  baseUrl: string;
  server: http.Server;
}

interface ProbeAgent {
  homeEnvName: string;
  homeEnvValue(realHome: string): string;
  writeRealHome(realHome: string): string;
  modelEnv(model: StubModel): Record<string, string>;
  serveModel(script: readonly ScriptedPrompt[]): http.RequestListener;
  turnEndEvent: string;
  permissionEvent: string;
  folderTrustFileName: string | null;
}

const SESSION_ID = "agent-probe-session";
const APPROVAL_FILE_NAME = "agent-probe-approval.txt";
const SENTINEL_WORD = "amberlattice";
const PROTECTED_FILE_NAME = "agent-probe-victim.txt";
const BLOCKED_COMMAND = `find . -name ${PROTECTED_FILE_NAME} -delete`;
const BOOT_SETTLE_MS = 6000;
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const USAGE = "Usage: node harness/probe-agent-session.ts <gemini|qwen|copilot> [--write-fixtures]\nRuns the real agent CLI against a local stub model, so it needs no login and bills nothing.";
const APPROVAL_PROMPT = `Run the shell command: touch ./${APPROVAL_FILE_NAME}`;
const SENTINEL_PROMPT = `reply with the single word ${SENTINEL_WORD} and nothing else`;
const BLOCKED_PROMPT = `Run the shell command: ${BLOCKED_COMMAND}`;
const MODEL_SCRIPT: readonly ScriptedPrompt[] = Object.freeze([
  { prompt: APPROVAL_PROMPT, firstReply: { shellCommand: `touch ./${APPROVAL_FILE_NAME}` } },
  { prompt: SENTINEL_PROMPT, firstReply: { text: SENTINEL_WORD } },
  { prompt: BLOCKED_PROMPT, firstReply: { shellCommand: BLOCKED_COMMAND } },
]);
const TOOL_RESULT_MARKERS: readonly string[] = Object.freeze(['"functionResponse"', '"role":"tool"']);

const { check, passed, failed } = createProbeChecks();

function scriptedReply(script: readonly ScriptedPrompt[], requestBody: string, servedPrompts: Set<string>): StubModelStep {
  const latest = script.map((entry) => ({ entry, at: requestBody.lastIndexOf(entry.prompt) })).filter(({ at }) => at >= 0).sort((left, right) => right.at - left.at)[0];
  if (!latest) return { text: "done" };
  const answeredText = requestBody.slice(latest.at);
  const hasToolResult = TOOL_RESULT_MARKERS.some((marker) => answeredText.includes(marker));
  if (hasToolResult || servedPrompts.has(latest.entry.prompt)) return { text: "done" };
  servedPrompts.add(latest.entry.prompt);
  return latest.entry.firstReply;
}

function geminiResponse(step: StubModelStep): unknown {
  const part = step.shellCommand ? { functionCall: { name: "run_shell_command", args: { command: step.shellCommand, description: "probe" } } } : { text: step.text ?? "done" };
  return { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } };
}

function serveGemini(script: readonly ScriptedPrompt[]): http.RequestListener {
  const servedPrompts = new Set<string>();
  return (request, response) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.includes("countTokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"totalTokens":5}');
        return;
      }
      if (!url.includes("streamGenerateContent")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(geminiResponse({ text: '{"next_speaker":"user","reasoning":"done"}' })));
        return;
      }
      const step = scriptedReply(script, Buffer.concat(bodyChunks).toString("utf8"), servedPrompts);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(geminiResponse(step))}\n\n`);
    });
  };
}

function openAiChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function openAiStream(step: StubModelStep, shellToolName: string): string {
  const usage = `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "probe", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`;
  if (step.shellCommand) {
    const toolCall = { index: 0, id: "probe-call", type: "function", function: { name: shellToolName, arguments: JSON.stringify({ command: step.shellCommand, description: "probe" }) } };
    return `${openAiChunk({ role: "assistant", tool_calls: [toolCall] }, null)}${openAiChunk({}, "tool_calls")}${usage}data: [DONE]\n\n`;
  }
  return `${openAiChunk({ role: "assistant", content: step.text ?? "done" }, null)}${openAiChunk({}, "stop")}${usage}data: [DONE]\n\n`;
}

function serveOpenAi(shellToolName: string): (script: readonly ScriptedPrompt[]) => http.RequestListener {
  return (script) => {
    const servedPrompts = new Set<string>();
    return (request, response) => {
    const bodyChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(bodyChunks).toString("utf8");
      const isStreamed = body.includes('"stream":true');
      if (!(request.url ?? "").includes("chat/completions") || !isStreamed) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "probe", object: "chat.completion", created: 0, model: "probe", choices: [{ index: 0, message: { role: "assistant", content: '{"next_speaker":"user","reasoning":"done"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, data: [] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(openAiStream(scriptedReply(script, body, servedPrompts), shellToolName));
    });
    };
  };
}

const PROBE_AGENTS: Readonly<Record<string, ProbeAgent>> = Object.freeze({
  gemini: {
    homeEnvName: "GEMINI_CLI_HOME",
    homeEnvValue: (realHome: string) => path.dirname(realHome),
    writeRealHome: (tempDirectory: string) => {
      const realHome = path.join(tempDirectory, "gemini-cli-home", ".gemini");
      fs.mkdirSync(realHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(realHome, "settings.json"), `${JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }, null, 2)}\n`, { mode: 0o600 });
      return realHome;
    },
    modelEnv: (model: StubModel) => ({ GEMINI_API_KEY: "glimmervoid-probe", GOOGLE_GEMINI_BASE_URL: model.baseUrl }),
    serveModel: serveGemini,
    turnEndEvent: "afteragent",
    permissionEvent: "notification",
    folderTrustFileName: null,
  },
  qwen: {
    homeEnvName: "QWEN_HOME",
    homeEnvValue: (realHome: string) => realHome,
    writeRealHome: (tempDirectory: string) => {
      const realHome = path.join(tempDirectory, "qwen-home");
      fs.mkdirSync(realHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(realHome, "settings.json"), `${JSON.stringify({ security: { auth: { selectedType: "openai" } }, model: { name: "probe" } }, null, 2)}\n`, { mode: 0o600 });
      return realHome;
    },
    modelEnv: (model: StubModel) => ({ OPENAI_API_KEY: "glimmervoid-probe", OPENAI_BASE_URL: `${model.baseUrl}/v1`, OPENAI_MODEL: "probe" }),
    serveModel: serveOpenAi("run_shell_command"),
    turnEndEvent: "stop",
    permissionEvent: "permissionrequest",
    folderTrustFileName: null,
  },
  copilot: {
    homeEnvName: "COPILOT_HOME",
    homeEnvValue: (realHome: string) => realHome,
    writeRealHome: (tempDirectory: string) => {
      const realHome = path.join(tempDirectory, "copilot-home");
      fs.mkdirSync(realHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(realHome, "settings.json"), "{}\n", { mode: 0o600 });
      return realHome;
    },
    modelEnv: (model: StubModel) => ({ COPILOT_PROVIDER_BASE_URL: `${model.baseUrl}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "glimmervoid-probe", COPILOT_MODEL: "probe", COPILOT_OFFLINE: "1" }),
    serveModel: serveOpenAi("bash"),
    turnEndEvent: "agentstop",
    permissionEvent: "permissionrequest",
    folderTrustFileName: "config.json",
  },
});

async function startStubModel(listener: http.RequestListener): Promise<StubModel> {
  const server = http.createServer(listener);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

function writeProbeConfig(configPath: string, projectDirectory: string, agentId: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: `${agentId} probe`, path: projectDirectory, agent: agentId, dangerouslySkipPermissions: false }],
    teams: [],
    repoRoots: [],
    autoResume: false,
    saneYolo: true,
    worktree: { autoRebase: false },
    capture: { enabled: true },
  }, null, 2), "utf8");
}

interface SpawnCall {
  args: string[];
  env: Record<string, string | undefined>;
}

async function runProbe(agentId: string, agent: ProbeAgent, tempDirectory: string): Promise<void> {
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  fs.writeFileSync(path.join(projectDirectory, PROTECTED_FILE_NAME), "keep\n");
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory, agentId);
  const realHome = agent.writeRealHome(tempDirectory);
  const snapshotRealConfig = (): string => fs.readdirSync(realHome).filter((name) => name !== agent.folderTrustFileName).map((name) => `${name}:${fs.readFileSync(path.join(realHome, name), "utf8")}`).join("\n");
  const realConfigBefore = snapshotRealConfig();
  const model = await startStubModel(agent.serveModel(MODEL_SCRIPT));
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, "glimmervoid-home");
  process.env[agent.homeEnvName] = agent.homeEnvValue(realHome);
  Object.assign(process.env, agent.modelEnv(model));

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const fixtureTarget: ProbeFixtureTarget = {
    agentId,
    tempDirectory,
    keepDirectory: fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-${agentId}-probe-out-`)),
    shouldWriteFixtures: SHOULD_WRITE_FIXTURES,
  };
  const hookRecords: ProbeHookRecord[] = [];
  const spawnCalls: SpawnCall[] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    spawnCalls.push({ args: [...spawnArgs], env: { ...spawnOptions.env } });
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session.on("state-change", ({ from, to, event }: { from: string; to: string; event: string }) => console.log(`  [state] ${from} -> ${to} (${event})`));
  session.on("hook-event", ({ event, payload }: { event: string; payload: HookPayload | null }) => {
    hookRecords.push({ event, payload: payload ?? null });
  });

  async function submit(prompt: string): Promise<void> {
    session.write(`\x1b[200~${prompt}\x1b[201~`);
    await delay(1200);
    session.write("\r");
  }

  async function runScenario(name: string, prompt: string, keepsFixture = true): Promise<ProbeHookRecord[]> {
    console.log(`\n${name}:`);
    const scenarioStart = hookRecords.length;
    await submit(prompt);
    await waitForState(session, ["RUNNING", "WAITING"], `${name} to start`);
    while ((await waitForState(session, ["COMPLETE", "WAITING"], `${name} to finish`)) === "WAITING") {
      console.log(`  [answer] ${name}`);
      await delay(1500);
      session.write("\r");
      await waitForState(session, ["RUNNING", "COMPLETE"], `${name} to resume`);
    }
    await delay(3000);
    const scenarioHooks = hookRecords.slice(scenarioStart);
    if (keepsFixture) console.log(`  [fixture] ${writeHookFixture(name, scenarioHooks, fixtureTarget)}`);
    console.log(`  [events] ${hookEventsOf(scenarioHooks).join(", ")}`);
    return scenarioHooks;
  }

  try {
    console.log("\nSpawn:");
    await session.start();
    check(`the spawn used the ${agentId} adapter`, session.agentId === agentId);
    await delay(BOOT_SETTLE_MS);
    const launchHome = spawnCalls[0]?.env[agent.homeEnvName];
    check(`${agent.homeEnvName} pointed at the generated home, not the real one`, !!launchHome && launchHome !== agent.homeEnvValue(realHome) && launchHome.startsWith(String(process.env.GLIMMERVOID_HOME)));

    const approvalEvents = hookEventsOf(await runScenario("approval-turn", APPROVAL_PROMPT));
    check("the permission prompt reached the hooks before the turn ended", approvalEvents.includes(agent.permissionEvent) && approvalEvents.indexOf(agent.permissionEvent) < approvalEvents.lastIndexOf(agent.turnEndEvent));
    check("the approved command ran", fs.existsSync(path.join(projectDirectory, APPROVAL_FILE_NAME)));
    const capturedId = session._resumeSessionId;
    check("a session id was captured from the hooks", typeof capturedId === "string" && capturedId.length > 0);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const turnEvents = hookEventsOf(await runScenario("turn-complete", SENTINEL_PROMPT));
    check("the resumed turn ended on its turn-end hook", turnEvents.includes(agent.turnEndEvent));
    check("resume kept the same session id", session._resumeSessionId === capturedId);
    for (const [index, call] of spawnCalls.entries()) console.log(`  [argv:${index + 1}] ${JSON.stringify(call.args)}`);
    check("the resumed argv carried the captured id", !!capturedId && !!spawnCalls[1]?.args.includes(capturedId));
    check("Sane YOLO was active", session.saneYolo);
    const blockedEvents = hookEventsOf(await runScenario("sane-yolo-block", BLOCKED_PROMPT, false));
    check("the turn with the refused command still ended", blockedEvents.includes(agent.turnEndEvent));
    check("Safety Net refused the command before it ran", fs.existsSync(path.join(projectDirectory, PROTECTED_FILE_NAME)));
    check("the real config was not written", snapshotRealConfig() === realConfigBefore);
    if (agent.folderTrustFileName) check("the project folder was pre-trusted", fs.readFileSync(path.join(realHome, agent.folderTrustFileName), "utf8").includes(projectDirectory));
  } finally {
    session.kill();
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await closeServer(server);
    model.server.closeAllConnections();
    await closeServer(model.server);
  }
}

async function main(): Promise<void> {
  const agentId = process.argv[2] ?? "";
  const agent = PROBE_AGENTS[agentId];
  if (!agent) {
    console.error(USAGE);
    process.exit(1);
  }
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-${agentId}-probe-`));
  try {
    await runProbe(agentId, agent, tempDirectory);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
  console.log(`\n${passed()} passed, ${failed()} failed`);
  process.exit(failed() === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

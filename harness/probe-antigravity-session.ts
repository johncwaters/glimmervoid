import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createBackend } from "../server/backend/backend.ts";
import { ENRICHED_PAYLOAD_KEYS } from "../session/core/antigravity-plugin-core.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import {
  backgroundSelfWakePrompt, BACKGROUND_SELF_WAKE_SETTLE_MS, closeServer, createProbeChecks, delay, hookEventsOf, installApprovedProbePack, queueWhiteboardEditFor, runModelSetupProbe, runPackAgentProbe, runResumeContinueProbe, SHOULD_RUN_ONLY_MODEL_SETUP_PROBE, SHOULD_RUN_ONLY_PACK_AGENT_PROBE, screenShowsWhiteboardAnswer, waitForState,
  whiteboardWriterIdFor, whiteboardWriterProject, WHITEBOARD_PROBE_PROMPT, writeHookFixture,
} from "./support/backend-harness.ts";
import type { ProbeFixtureTarget, ProbeHookRecord, ProbeLaunch } from "./support/backend-harness.ts";

const AGENT_ID = "antigravity";
const SESSION_ID = "antigravity-probe-session";
const SENTINEL_WORD = "copperheron";
const APPROVAL_FILE_NAME = "antigravity-probe-approval.txt";
const BOOT_SETTLE_MS = 8000;
const PERMISSION_PROMPTING_MODE_ARGS = ["--mode", "accept-edits"];
const PLUGIN_FOLDER_WRITTEN_BY_THIS_CHECKOUT = path.join(os.homedir(), ".gemini", "config", "plugins", "glimmervoid");
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const SHOULD_RUN_ONLY_SUBAGENT_PROBE = process.argv.includes("--only-subagent");
const SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE = process.argv.includes("--only-question-manager");
const QUESTION_MANAGER_PROBE_SETTINGS = { rules: [{ name: "color", question: "red or blue", pick: ["blue"] }] };
const BACKGROUND_SHELL_SLEEP_SECONDS = 4;
const QUESTION_PROMPT = "Use your ask_question tool to ask me whether I prefer red or blue, then reply with only my answer.";
const PLAN_PROMPT = "Present a one-step plan to create plan.txt containing ok, use your ask_question tool to ask me to approve it with the options approve and reject, then carry it out once approved.";
const SUBAGENT_PROMPT = "Use your invoke_subagent tool to have a subagent run ls in the current directory and report the file names. Then reply with the single word done.";

const { check, passed, failed } = createProbeChecks();

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "antigravity probe",
      path: projectDirectory,
      agent: AGENT_ID,
      dangerouslySkipPermissions: false,
      questionManagerOn: SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE,
    }, whiteboardWriterProject(SESSION_ID, projectDirectory, AGENT_ID)],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktree: { autoRebase: false },
    capture: { enabled: true },
    ...(SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE ? { questionManager: QUESTION_MANAGER_PROBE_SETTINGS } : {}),
  }, null, 2), "utf8");
}

function settingsOf(launch: ProbeLaunch | undefined): Record<string, unknown> {
  const args = launch?.args ?? [];
  const settingsText = args[args.indexOf("--settings") + 1] ?? "{}";
  const parsed: unknown = JSON.parse(settingsText);
  return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
}

async function runProbe(tempDirectory: string): Promise<void> {
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, "glimmervoid-home");
  if (SHOULD_RUN_ONLY_PACK_AGENT_PROBE) await installApprovedProbePack(process.env.GLIMMERVOID_HOME);

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const fixtureTarget: ProbeFixtureTarget = {
    agentId: AGENT_ID,
    tempDirectory,
    keepDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-antigravity-probe-out-")),
    shouldWriteFixtures: SHOULD_WRITE_FIXTURES,
    enrichedPayloadKeys: ENRICHED_PAYLOAD_KEYS,
  };
  const hookRecords: ProbeHookRecord[] = [];
  const launches: ProbeLaunch[] = [];
  const completions: number[] = [];
  let taskTitleResets = 0;
  session.on("task-title-reset", () => { taskTitleResets += 1; });
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    launches.push({ args: [...spawnArgs], env: { ...spawnOptions.env } });
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session.on("state-change", ({ from, to, event }: { from: string; to: string; event: string }) => {
    console.log(`  [state] ${from} -> ${to} (${event})`);
    if (to === "COMPLETE") completions.push(hookRecords.length);
  });
  session.on("hook-event", ({ event, payload }: { event: string; payload: HookPayload | null }) => {
    hookRecords.push({ event, payload: payload ?? null });
  });

  async function submit(prompt: string): Promise<void> {
    session.write(`\x1b[200~${prompt}\x1b[201~`);
    await delay(1200);
    session.write("\r");
  }

  async function typeCommand(command: string): Promise<void> {
    session.write(command);
    await delay(1500);
    session.write("\r");
  }

  async function waitForHook(label: string, since: number, eventName: string): Promise<boolean> {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (hookRecords.slice(since).some((hook) => hook.event.toLowerCase() === eventName)) return true;
      await delay(500);
    }
    console.error(`  [timeout] ${label}`);
    return false;
  }

  async function pressEnter(): Promise<void> {
    await delay(1500);
    session.write("\r");
  }

  function captureSince(name: string, scenarioStart: number): ProbeHookRecord[] {
    const scenarioHooks = hookRecords.slice(scenarioStart);
    console.log(`  [fixture] ${writeHookFixture(name, scenarioHooks, fixtureTarget)}`);
    console.log(`  [events] ${hookEventsOf(scenarioHooks).join(", ")}`);
    return scenarioHooks;
  }

  async function runScenario(name: string, prompt: string | null, settleMs = 3000): Promise<ProbeHookRecord[]> {
    console.log(`\n${name}:`);
    const scenarioStart = hookRecords.length;
    if (prompt !== null) await submit(prompt);
    await waitForState(session, ["RUNNING", "WAITING"], `${name} to start`);
    while ((await waitForState(session, ["COMPLETE", "WAITING"], `${name} to finish`)) === "WAITING") {
      console.log(`  [answer] ${name}`);
      await pressEnter();
      await waitForState(session, ["RUNNING", "COMPLETE"], `${name} to resume`);
    }
    await delay(settleMs);
    return captureSince(name, scenarioStart);
  }

  try {
    if (SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE) {
      session._extraClaudeArgs = ["--dangerously-skip-permissions"];
      await session.start();
      await waitForState(session, ["IDLE"], "agy boot");
      await delay(BOOT_SETTLE_MS);
      const managerEntries = () => session.auditLog.filter((entry) => entry.kind === "question-manager");
      let waitsSeen = 0;
      const promptKindsSeen: string[] = [];
      session.on("prompt-kind-change", ({ pendingPromptKind }: { pendingPromptKind: string | null }) => { if (pendingPromptKind) promptKindsSeen.push(pendingPromptKind); });
      session.on("state-change", ({ to }: { to: string }) => { if (to === "WAITING") waitsSeen += 1; });
      const answeredHooks = await runScenario("question-manager-answered", QUESTION_PROMPT);
      const transcriptPath = answeredHooks.map((hook) => hook.payload?.transcriptPath).find((value) => typeof value === "string");
      check("the answered question never put the card in WAITING", waitsSeen === 0);
      check("the manager wrote an answered audit entry", managerEntries().some((entry) => entry.outcome === "answered" && entry.rule === "color"));
      check("the manager's answer reached the model as the deny reason", typeof transcriptPath === "string" && fs.readFileSync(transcriptPath, "utf8").includes("question manager answered"));
      const waitsBeforeEscalation = waitsSeen;
      await runScenario("question-manager-escalated", "Use your ask_question tool to ask me whether to delete the notes file, with the options yes and no, then reply with only my answer.");
      check("the risky question reached the operator as WAITING", waitsSeen > waitsBeforeEscalation);
      check("the risky question showed as a question, not a permission", promptKindsSeen.includes("elicitation") && !promptKindsSeen.includes("permission"));
      check("the manager escalated the risky question", managerEntries().some((entry) => entry.outcome === "escalated" && /delete/i.test(String(entry.reason))));
      return;
    }
    if (SHOULD_RUN_ONLY_SUBAGENT_PROBE) {
      session._extraClaudeArgs = ["--dangerously-skip-permissions"];
      session._initialPrompt = SUBAGENT_PROMPT;
      await session.start();
      const completionsBeforeSubagent = completions.length;
      const subagentHooks = await runScenario("subagent", null);
      check("the subagent turn completed the card exactly once", completions.length - completionsBeforeSubagent === 1);
      check("the subagent's own SessionStart and Stop were tagged with its conversation id", ["sessionstart", "stop"].every((event) => subagentHooks.some((hook) => hook.event.toLowerCase() === event && typeof hook.payload?.agent_id === "string")));
      return;
    }
    if (SHOULD_RUN_ONLY_MODEL_SETUP_PROBE) {
      session._extraClaudeArgs = PERMISSION_PROMPTING_MODE_ARGS;
      await runModelSetupProbe({ session, agent: AGENT_ID, hookRecords, fixtureTarget, check, answerWaiting: pressEnter });
      return;
    }
    if (SHOULD_RUN_ONLY_PACK_AGENT_PROBE) {
      session._extraClaudeArgs = PERMISSION_PROMPTING_MODE_ARGS;
      await runPackAgentProbe({ session, configPath, hookRecords, fixtureTarget, check, answerWaiting: pressEnter });
      check("the launch added each pack's skill workspace with --add-dir", launches.at(-1)?.args.includes("--add-dir") === true);
      return;
    }
    console.log("\nSpawn:");
    session._extraClaudeArgs = PERMISSION_PROMPTING_MODE_ARGS;
    session._initialPrompt = `Run the shell command: touch ./${APPROVAL_FILE_NAME}`;
    await session.start();
    check("the spawn used the antigravity adapter", session.agentId === AGENT_ID);
    const launchSettings = settingsOf(launches[0]);
    check("the launch trusted the session folder through --settings", Array.isArray(launchSettings.trustedWorkspaces) && launchSettings.trustedWorkspaces.length === 1);
    check("the launch set the AgentState title command through --settings", JSON.stringify(launchSettings.title ?? "").includes("AgentState"));
    const approvalHooks = await runScenario("approval-turn", null);
    session._initialPrompt = null;
    const approvalEvents = hookEventsOf(approvalHooks);
    check("SessionStart fired before the first PreInvocation", approvalEvents.indexOf("sessionstart") >= 0 && approvalEvents.indexOf("sessionstart") < approvalEvents.indexOf("preinvocation"));
    check("the permission dialog reached the hooks as AgentState tool_use before Stop", approvalHooks.some((hook) => hook.event.toLowerCase() === "agentstate" && hook.payload?.agent_state === "tool_use"));
    check("the approved command ran", fs.existsSync(path.join(projectDirectory, APPROVAL_FILE_NAME)));
    const capturedId = session._resumeSessionId;
    check("a conversation id was captured from the hooks", typeof capturedId === "string" && capturedId.length > 0);

    const mcpHooks = await runScenario("mcp-tool", "Call your glimmervoid MCP server's session tool with action limits, then reply with the single word done.");
    check("the agent called a Glimmervoid MCP tool through the stdio bridge", mcpHooks.some((hook) => hook.event.toLowerCase() === "pretooluse" && JSON.stringify(hook.payload?.toolCall ?? "").includes("limits")));

    const writer = backend.getSession(whiteboardWriterIdFor(SESSION_ID));
    if (!writer) throw new Error("the probe config did not produce the board writer session");
    await queueWhiteboardEditFor(backend, session, writer);
    const whiteboardOutputOffset = session.getOutputOffset();
    const whiteboardHooks = await runScenario("whiteboard-prompt-context", WHITEBOARD_PROBE_PROMPT);
    check("PreInvocation reached the hooks", hookEventsOf(whiteboardHooks).includes("preinvocation"));
    check("the queued board edit reached the model with the prompt", screenShowsWhiteboardAnswer(session.getBufferSince(whiteboardOutputOffset).data));

    const questionHooks = await runScenario("ask-question", QUESTION_PROMPT);
    check("the question reached the hooks as ask_question before Stop", questionHooks.some((hook) => hook.event.toLowerCase() === "pretooluse" && JSON.stringify(hook.payload?.toolCall ?? "").includes("ask_question")));

    const planHooks = await runScenario("plan-wait", PLAN_PROMPT, 5000);
    check("the plan turn ended on Stop", hookEventsOf(planHooks).includes("stop"));
    check("the approved plan ran", fs.existsSync(path.join(projectDirectory, "plan.txt")));

    const completionsBeforeBackground = completions.length;
    await runScenario("background-self-wake", backgroundSelfWakePrompt(BACKGROUND_SHELL_SLEEP_SECONDS), BACKGROUND_SELF_WAKE_SETTLE_MS + BACKGROUND_SHELL_SLEEP_SECONDS * 1000);
    check("the background turn completed the card exactly once", completions.length - completionsBeforeBackground === 1);

    console.log("\nsession-clear:");
    const clearStart = hookRecords.length;
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the turn before /clear ended on Stop", await waitForHook("Stop before /clear", clearStart, "stop"));
    await delay(3000);
    const clearCommandStart = hookRecords.length;
    const taskTitleResetsBeforeClear = taskTitleResets;
    const idBeforeClear = session._resumeSessionId;
    await typeCommand("/clear");
    await delay(3000);
    console.log(`  [after /clear] ${hookEventsOf(hookRecords.slice(clearCommandStart)).join(", ")}`);
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the first turn after /clear ended on Stop", await waitForHook("Stop after /clear", clearCommandStart, "stop"));
    await delay(3000);
    captureSince("session-clear", clearStart);
    check("the card reset its task title on /clear", taskTitleResets > taskTitleResetsBeforeClear);
    const clearedId = session._resumeSessionId;
    check("/clear moved the card to a new conversation id", typeof clearedId === "string" && clearedId !== idBeforeClear);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const turnHooks = await runScenario("turn-complete", `reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the resumed turn ended on Stop", hookEventsOf(turnHooks).includes("stop"));
    check("resume kept the same conversation id", session._resumeSessionId === clearedId);
    check("the resumed argv carried --conversation with the cleared id", !!clearedId && launches.at(-1)?.args.join(" ").includes(`--conversation ${clearedId}`) === true);

    await runResumeContinueProbe({ session, hookRecords, fixtureTarget, check, answerWaiting: pressEnter, submitFirstTurn: null });
  } finally {
    session.kill();
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await closeServer(server);
  }
}

async function main(): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-antigravity-probe-"));
  try {
    await runProbe(tempDirectory);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    fs.rmSync(PLUGIN_FOLDER_WRITTEN_BY_THIS_CHECKOUT, { recursive: true, force: true });
  }
  console.log(`\n${passed()} passed, ${failed()} failed`);
  process.exit(failed() === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

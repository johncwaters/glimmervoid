import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createBackend } from "../server/backend/backend.ts";
import type { Session } from "../session/sessions.ts";
import type { AgentSetup } from "../shared/contracts/agent-models.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import {
  backgroundSelfWakePrompt, BACKGROUND_SELF_WAKE_SETTLE_MS, closeServer, createProbeChecks, delay, hookEventsOf, installApprovedProbePack, queueWhiteboardEditFor,
  runModelSetupProbe, runPackAgentProbe, runPackMcpProbe, SHOULD_RUN_ONLY_PACK_MCP_PROBE, runResumeContinueProbe, screenShowsWhiteboardAnswer, SHOULD_RUN_ONLY_MODEL_SETUP_PROBE, SHOULD_RUN_ONLY_PACK_AGENT_PROBE, SHOULD_RUN_ONLY_RESUME_CONTINUE_PROBE,
  waitForState, whiteboardWriterIdFor, whiteboardWriterProject, WHITEBOARD_PROBE_PROMPT, writeHookFixture,
} from "./support/backend-harness.ts";
import type { ProbeFixtureTarget, ProbeHookRecord, ProbeLaunch } from "./support/backend-harness.ts";

const SESSION_ID = "pi-probe-session";
const SENTINEL_WORD = "copperheron";
const APPROVAL_FILE_NAME = "pi-probe-approval.txt";
const COMPACTION_KEEP_RECENT_TOKENS = 200;
const BOOT_SETTLE_MS = 8000;
const COMPACTION_SETTLE_MS = 40000;
const PROBE_MODEL = process.env.GLIMMERVOID_PI_PROBE_MODEL ?? "";
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE = process.argv.includes("--only-question-manager");
const QUESTION_MANAGER_PROBE_SETTINGS = { rules: [{ name: "color", question: "red or blue", pick: ["blue"] }] };
const QUESTION_PROMPT = "Use your ask_user_question tool to ask me whether I prefer red or blue, then reply with only my answer.";
const MANAGED_QUESTION_PROMPT = "Use your ask_user_question tool to ask me exactly the question 'Do you prefer red or blue?' with the options red and blue, then reply with only my answer.";
const PLAN_PROMPT = "Present a one-step plan to create plan.txt containing ok, use your ask_user_question tool to ask me to approve it with the options approve and reject, then carry it out once approved.";
const BACKGROUND_SHELL_SLEEP_SECONDS = 4;
const SUBAGENT_PROMPT = "Use a subagent to run ls in the current directory and report the file names if you have a subagent tool, otherwise run ls yourself. Then reply with the single word done.";
const AGENT_DIR_ENV_NAME = "PI_CODING_AGENT_DIR";
const LAUNCH_ENV_NAME = "GLIMMERVOID_PI_LAUNCH";

const { check, passed, failed } = createProbeChecks();

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "pi probe",
      path: projectDirectory,
      agent: "pi",
      dangerouslySkipPermissions: false,
      questionManagerOn: SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE,
    }, whiteboardWriterProject(SESSION_ID, projectDirectory, "pi")],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktree: { autoRebase: false },
    capture: { enabled: true },
    ...(SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE ? { questionManager: QUESTION_MANAGER_PROBE_SETTINGS } : {}),
  }, null, 2), "utf8");
}

function isolatePi(tempDirectory: string): void {
  const agentDirectory = path.join(tempDirectory, "pi-agent");
  fs.mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
  const separatorAt = PROBE_MODEL.indexOf("/");
  const operatorModel = SHOULD_RUN_ONLY_MODEL_SETUP_PROBE ? {} : { defaultProvider: PROBE_MODEL.slice(0, separatorAt), defaultModel: PROBE_MODEL.slice(separatorAt + 1) };
  fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ ...operatorModel, quietStartup: true, compaction: { keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS } }), { mode: 0o600 });
  process.env[AGENT_DIR_ENV_NAME] = agentDirectory;
}

function launchConfigOf(launch: ProbeLaunch | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(launch?.env[LAUNCH_ENV_NAME] ?? "{}");
  return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
}

async function runProbe(tempDirectory: string): Promise<void> {
  if (!PROBE_MODEL.includes("/")) throw new Error("set GLIMMERVOID_PI_PROBE_MODEL to a provider/model id pi can reach with the keys in this environment");
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, "glimmervoid-home");
  isolatePi(tempDirectory);
  if (SHOULD_RUN_ONLY_PACK_AGENT_PROBE) await installApprovedProbePack(process.env.GLIMMERVOID_HOME);

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const fixtureTarget: ProbeFixtureTarget = {
    agentId: "pi",
    tempDirectory,
    keepDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-pi-probe-out-")),
    shouldWriteFixtures: SHOULD_WRITE_FIXTURES,
  };
  const hookRecords: ProbeHookRecord[] = [];
  const completions: number[] = [];
  const launches: ProbeLaunch[] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    launches.push({ args: [...spawnArgs], env: { ...spawnOptions.env } });
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session.on("state-change", ({ from, to, event }: { from: string; to: string; event: string }) => {
    console.log(`  [state] ${from} -> ${to} (${event})`);
    if (to === "COMPLETE") completions.push(hookRecords.length);
  });
  let taskTitleResets = 0;
  session.on("task-title-reset", () => { taskTitleResets += 1; });
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

  async function pressEnter(): Promise<void> {
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

  function captureSince(name: string, scenarioStart: number): ProbeHookRecord[] {
    const scenarioHooks = hookRecords.slice(scenarioStart);
    console.log(`  [fixture] ${writeHookFixture(name, scenarioHooks, fixtureTarget)}`);
    console.log(`  [events] ${hookEventsOf(scenarioHooks).join(", ")}`);
    return scenarioHooks;
  }

  async function runScenario(name: string, prompt: string | null, answerWaiting: () => Promise<void>, settleMs = 3000): Promise<ProbeHookRecord[]> {
    console.log(`\n${name}:`);
    const scenarioStart = hookRecords.length;
    if (prompt !== null) await submit(prompt);
    await waitForState(session, ["RUNNING", "WAITING"], `${name} to start`);
    while ((await waitForState(session, ["COMPLETE", "WAITING"], `${name} to finish`)) === "WAITING") {
      console.log(`  [answer] ${name}`);
      await answerWaiting();
      await waitForState(session, ["RUNNING", "COMPLETE"], `${name} to resume`);
    }
    await delay(settleMs);
    return captureSince(name, scenarioStart);
  }

  try {
    if (SHOULD_RUN_ONLY_MODEL_SETUP_PROBE) {
      const pickedSetup: AgentSetup = { agent: "pi", model: PROBE_MODEL, options: [], instructions: "" };
      await runModelSetupProbe({ session, agent: "pi", hookRecords, fixtureTarget, check, answerWaiting: pressEnter, pickedSetup });
      return;
    }
    if (SHOULD_RUN_ONLY_PACK_AGENT_PROBE) {
      await runPackAgentProbe({ session, configPath, hookRecords, fixtureTarget, check, answerWaiting: pressEnter });
      return;
    }
    if (SHOULD_RUN_ONLY_PACK_MCP_PROBE) {
      await runPackMcpProbe({ session, hookRecords, fixtureTarget, check, answerWaiting: pressEnter });
      return;
    }

    console.log("\nSpawn:");
    session._initialPrompt = `Run the shell command: touch ./${APPROVAL_FILE_NAME}`;
    await session.start();
    check("the spawn used the pi adapter", session.agentId === "pi");
    const extensionPath = launches[0]?.args[1] ?? "";
    check("the launch loaded the generated extension with -e", launches[0]?.args[0] === "-e" && extensionPath.startsWith(String(process.env.GLIMMERVOID_HOME)) && fs.existsSync(extensionPath));
    check("the launch named the Glimmervoid MCP endpoint", typeof launchConfigOf(launches[0]).mcpUrl === "string");
    const approvalHooks = await runScenario("approval-turn", null, pressEnter);
    session._initialPrompt = null;
    const approvalEvents = hookEventsOf(approvalHooks);
    check("SessionStart fired first", approvalEvents[0] === "sessionstart");
    check("PermissionRequest preceded the turn's Stop", approvalEvents.indexOf("permissionrequest") >= 0 && approvalEvents.indexOf("permissionrequest") < approvalEvents.lastIndexOf("stop"));
    check("the approved command ran", fs.existsSync(path.join(projectDirectory, APPROVAL_FILE_NAME)));
    const capturedId = session._resumeSessionId;
    check("a session id was captured from the hooks", typeof capturedId === "string" && capturedId.length > 0);

    if (SHOULD_RUN_ONLY_RESUME_CONTINUE_PROBE) {
      await runResumeContinueProbe({ session, hookRecords, fixtureTarget, check, answerWaiting: pressEnter, submitFirstTurn: null });
      return;
    }

    if (SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE) {
      const managerEntries = () => session.auditLog.filter((entry) => entry.kind === "question-manager");
      let answeredQuestionWaits = 0;
      const answeredHooks = await runScenario("question-manager-answered", MANAGED_QUESTION_PROMPT, async () => {
        answeredQuestionWaits += 1;
        await pressEnter();
      });
      check("the answered question never put the card in WAITING", answeredQuestionWaits === 0);
      check("the manager wrote an answered audit entry", managerEntries().some((entry) => entry.outcome === "answered" && entry.rule === "color"));
      check("the answered question never opened the pi dialog", !hookEventsOf(answeredHooks).includes("elicitation"));
      return;
    }

    const writer = backend.getSession(whiteboardWriterIdFor(SESSION_ID));
    if (!writer) throw new Error("the probe config did not produce the board writer session");
    await queueWhiteboardEditFor(backend, session, writer);
    const whiteboardOutputOffset = session.getOutputOffset();
    const whiteboardHooks = await runScenario("whiteboard-prompt-context", WHITEBOARD_PROBE_PROMPT, pressEnter);
    check("UserPromptSubmit reached the hooks", hookEventsOf(whiteboardHooks).includes("userpromptsubmit"));
    check("the queued board edit reached the model with the prompt", screenShowsWhiteboardAnswer(session.getBufferSince(whiteboardOutputOffset).data));

    const questionHooks = await runScenario("ask-question", QUESTION_PROMPT, pressEnter);
    check("the question dialog reached the hooks as Elicitation then ElicitationResult", hookEventsOf(questionHooks).join(",").includes("elicitation,elicitationresult"));
    check("the question dialog carried the AskUserQuestion call", questionHooks.some((hook) => hook.event.toLowerCase() === "elicitation" && hook.payload?.tool_name === "AskUserQuestion"));

    const planHooks = await runScenario("plan-wait", PLAN_PROMPT, pressEnter, 5000);
    check("the plan approval waited on the operator", hookEventsOf(planHooks).includes("elicitation"));
    check("the plan turn ended on Stop", hookEventsOf(planHooks).includes("stop"));

    const completionsBeforeSubagent = completions.length;
    await runScenario("subagent", SUBAGENT_PROMPT, pressEnter);
    check("the subagent turn completed the card exactly once", completions.length - completionsBeforeSubagent === 1);

    const completionsBeforeBackground = completions.length;
    await runScenario("background-self-wake", backgroundSelfWakePrompt(BACKGROUND_SHELL_SLEEP_SECONDS), pressEnter, BACKGROUND_SELF_WAKE_SETTLE_MS + BACKGROUND_SHELL_SLEEP_SECONDS * 1000);
    check("the background turn completed the card exactly once", completions.length - completionsBeforeBackground === 1);

    console.log("\nidle-compaction:");
    const compactionStart = hookRecords.length;
    const completionsBeforeCompaction = completions.length;
    await typeCommand("/compact");
    await delay(COMPACTION_SETTLE_MS);
    const compactionEvents = hookEventsOf(captureSince("idle-compaction", compactionStart));
    check("an idle compaction relayed only PreCompact and PostCompact", compactionEvents.join(",") === "precompact,postcompact");
    check("the idle compaction left the card COMPLETE without a new completion", session.state === "COMPLETE" && completions.length === completionsBeforeCompaction);

    console.log("\nsession-clear:");
    const clearStart = hookRecords.length;
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the turn before /new ended on Stop", await waitForHook("Stop before /new", clearStart, "stop"));
    await delay(3000);
    const clearCommandStart = hookRecords.length;
    const taskTitleResetsBeforeClear = taskTitleResets;
    await typeCommand("/new");
    await delay(3000);
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the first turn after /new ended on Stop", await waitForHook("Stop after /new", clearCommandStart, "stop"));
    check("SessionStart fired after /new", await waitForHook("SessionStart after /new", clearCommandStart, "sessionstart"));
    check("the card reset its task title on /new", taskTitleResets > taskTitleResetsBeforeClear);
    await delay(3000);
    const clearHooks = captureSince("session-clear", clearStart);
    check("/new reported SessionStart source clear", clearHooks.some((hook) => hook.event.toLowerCase() === "sessionstart" && hook.payload?.source === "clear"));
    const clearedId = session._resumeSessionId;
    check("/new moved the card to the new session id", typeof clearedId === "string" && clearedId !== capturedId);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const turnHooks = await runScenario("turn-complete", `reply with the single word ${SENTINEL_WORD} and nothing else`, pressEnter);
    check("the resumed turn ended on Stop", hookEventsOf(turnHooks).includes("stop"));
    check("resume kept the same session id", session._resumeSessionId === clearedId);
    check("the resumed argv carried --session with the captured id", !!clearedId && launches.at(-1)?.args.join(" ").includes(`--session ${clearedId}`) === true);

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
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-pi-probe-"));
  try {
    await runProbe(tempDirectory);
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

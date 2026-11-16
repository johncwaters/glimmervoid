import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBackend } from "../server/backend/backend.ts";
import type { Session } from "../session/sessions.ts";
import type { AgentSetup } from "../shared/contracts/agent-models.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import {
  backgroundSelfWakePrompt, BACKGROUND_SELF_WAKE_SETTLE_MS, closeServer, createProbeChecks, delay, hookEventsOf, installApprovedProbePack, queueWhiteboardEditFor,
  runModelSetupProbe, runPackAgentProbe, runResumeContinueProbe, screenShowsWhiteboardAnswer, SHOULD_RUN_ONLY_BACKGROUND_SELF_WAKE_PROBE, SHOULD_RUN_ONLY_MODEL_SETUP_PROBE, SHOULD_RUN_ONLY_PACK_AGENT_PROBE,
  waitForState, whiteboardWriterIdFor, whiteboardWriterProject, WHITEBOARD_PROBE_PROMPT, writeHookFixture,
} from "./support/backend-harness.ts";
import type { ProbeFixtureTarget, ProbeHookRecord, ProbeLaunch } from "./support/backend-harness.ts";

const SESSION_ID = "opencode-probe-session";
const SENTINEL_WORD = "copperheron";
const APPROVAL_FILE_NAME = "opencode-probe-approval.txt";
const BOOT_SETTLE_MS = 8000;
const SUBAGENT_SETTLE_MS = 15000;
const COMPACTION_SETTLE_MS = 40000;
const PROBE_MODEL = process.env.GLIMMERVOID_OPENCODE_PROBE_MODEL ?? "";
const BACKGROUND_SHELL_SLEEP_SECONDS = 45;
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE = process.argv.includes("--only-question-manager");
const QUESTION_MANAGER_PROBE_SETTINGS = { rules: [{ name: "color", question: "red or blue", pick: ["blue"] }] };
const QUESTION_PROMPT = "Use your question tool to ask me whether I prefer red or blue, then reply with only my answer.";
const MANAGED_QUESTION_PROMPT = "Use your question tool to ask me exactly the question 'Do you prefer red or blue?' with the options red and blue, then reply with only my answer.";
const PLAN_PROMPT = "Present a one-step plan to create plan.txt containing ok, use your question tool to ask me to approve it with the options approve and reject, then carry it out once approved.";
const XDG_DIRECTORY_ENV_NAMES = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
const CONFIG_CONTENT_ENV_NAME = "OPENCODE_CONFIG_CONTENT";

const { check, passed, failed } = createProbeChecks();

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "opencode probe",
      path: projectDirectory,
      agent: "opencode",
      dangerouslySkipPermissions: false,
      questionManagerOn: SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE,
    }, whiteboardWriterProject(SESSION_ID, projectDirectory, "opencode")],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktree: { autoRebase: false },
    capture: { enabled: true },
    ...(SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE ? { questionManager: QUESTION_MANAGER_PROBE_SETTINGS } : {}),
  }, null, 2), "utf8");
}

function isolateOpenCode(tempDirectory: string): void {
  for (const envName of XDG_DIRECTORY_ENV_NAMES) {
    const directory = path.join(tempDirectory, "opencode-home", envName.toLowerCase());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    process.env[envName] = directory;
  }
  const operatorModel = SHOULD_RUN_ONLY_MODEL_SETUP_PROBE ? {} : { model: PROBE_MODEL };
  process.env[CONFIG_CONTENT_ENV_NAME] = JSON.stringify({ ...operatorModel, permission: { bash: "ask", edit: "ask" } });
}

function launchConfigOf(launch: ProbeLaunch | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(launch?.env[CONFIG_CONTENT_ENV_NAME] ?? "{}");
  return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
}

function launchConfigCarriesModel(setup: AgentSetup, launch: ProbeLaunch): boolean {
  return launchConfigOf(launch).model === setup.model;
}

async function runProbe(tempDirectory: string): Promise<void> {
  if (!PROBE_MODEL) throw new Error("set GLIMMERVOID_OPENCODE_PROBE_MODEL to a provider/model id OpenCode can reach with the keys in this environment");
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, "glimmervoid-home");
  isolateOpenCode(tempDirectory);
  if (SHOULD_RUN_ONLY_PACK_AGENT_PROBE) await installApprovedProbePack(process.env.GLIMMERVOID_HOME);

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const fixtureTarget: ProbeFixtureTarget = {
    agentId: "opencode",
    tempDirectory,
    keepDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-opencode-probe-out-")),
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

  async function approveOnce(): Promise<void> {
    await delay(1500);
    session.write("\r");
  }

  async function pickFirstOption(): Promise<void> {
    await delay(1500);
    session.write("\r");
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

  async function runBackgroundSelfWake(): Promise<void> {
    const completionsBeforeSelfWake = completions.length;
    const selfWakeHooks = await runScenario("background-self-wake", backgroundSelfWakePrompt(BACKGROUND_SHELL_SLEEP_SECONDS), approveOnce, BACKGROUND_SELF_WAKE_SETTLE_MS + BACKGROUND_SHELL_SLEEP_SECONDS * 1000);
    const selfWakeEvents = hookEventsOf(selfWakeHooks);
    const notificationIndex = selfWakeHooks.findIndex((hook) => hook.event.toLowerCase() === "userpromptsubmit" && String(hook.payload?.prompt ?? "").includes("<task-notification>"));
    check("the background shell launch reached the hooks", selfWakeHooks.some((hook) => hook.event.toLowerCase() === "posttooluse" && typeof hook.payload?.tool_response === "object"));
    check("the wake arrived as a task notification prompt after the launching turn stopped", notificationIndex > 0 && selfWakeEvents.slice(0, notificationIndex).includes("stop"));
    check("the background turn completed the card exactly once", completions.length - completionsBeforeSelfWake === 1);
  }

  try {
    if (SHOULD_RUN_ONLY_MODEL_SETUP_PROBE) {
      const pickedSetup: AgentSetup = { agent: "opencode", model: PROBE_MODEL, options: [], instructions: "" };
      await runModelSetupProbe({ session, agent: "opencode", hookRecords, fixtureTarget, check, answerWaiting: approveOnce, pickedSetup, launchCarriesSetup: launchConfigCarriesModel });
      return;
    }
    if (SHOULD_RUN_ONLY_PACK_AGENT_PROBE) {
      await runPackAgentProbe({ session, configPath, hookRecords, fixtureTarget, check, answerWaiting: approveOnce });
      return;
    }

    console.log("\nSpawn:");
    session._initialPrompt = `Run the shell command: touch ./${APPROVAL_FILE_NAME}`;
    await session.start();
    check("the spawn used the opencode adapter", session.agentId === "opencode");
    const launchConfig = launchConfigOf(launches[0]);
    const launchPlugins = Array.isArray(launchConfig.plugins) ? launchConfig.plugins.map(String) : [];
    const pluginFolder = launchPlugins.map((entry) => entry.startsWith("file:") ? fileURLToPath(entry) : "").find((folder) => folder.startsWith(String(process.env.GLIMMERVOID_HOME))) ?? null;
    check("OPENCODE_CONFIG_CONTENT loaded the generated plugin folder", !!pluginFolder && fs.existsSync(path.join(pluginFolder, "index.js")));
    check("OPENCODE_CONFIG_CONTENT kept the operator's own settings", launchConfig.model === PROBE_MODEL);
    check("OPENCODE_CONFIG_DIR was left alone", launches[0]?.env.OPENCODE_CONFIG_DIR === undefined);
    check("the launch ran a private server", !!launches[0]?.args.includes("--standalone"));
    const approvalHooks = await runScenario("approval-turn", null, approveOnce);
    session._initialPrompt = null;
    const approvalEvents = hookEventsOf(approvalHooks);
    check("SessionStart fired first", approvalEvents[0] === "sessionstart");
    check("PermissionRequest preceded the turn's Stop", approvalEvents.indexOf("permissionrequest") >= 0 && approvalEvents.indexOf("permissionrequest") < approvalEvents.lastIndexOf("stop"));
    check("the approved command ran", fs.existsSync(path.join(projectDirectory, APPROVAL_FILE_NAME)));
    const capturedId = session._resumeSessionId;
    check("the captured session id is an OpenCode ses_ id", /^ses_[0-9A-Za-z]+$/.test(String(capturedId || "")));

    if (SHOULD_RUN_ONLY_BACKGROUND_SELF_WAKE_PROBE) {
      await runBackgroundSelfWake();
      return;
    }

    if (SHOULD_RUN_ONLY_QUESTION_MANAGER_PROBE) {
      const managerEntries = () => session.auditLog.filter((entry) => entry.kind === "question-manager");
      let answeredQuestionWaits = 0;
      const answeredHooks = await runScenario("question-manager-answered", MANAGED_QUESTION_PROMPT, async () => {
        answeredQuestionWaits += 1;
        await pickFirstOption();
      });
      check("the answered question never put the card in WAITING", answeredQuestionWaits === 0);
      check("the manager wrote an answered audit entry", managerEntries().some((entry) => entry.outcome === "answered" && entry.rule === "color"));
      check("the answered question never opened the OpenCode form", !hookEventsOf(answeredHooks).includes("elicitation"));
      let escalatedQuestionWaits = 0;
      await runScenario("question-manager-escalated", "Use your question tool to ask me whether to delete the notes file, with the options yes and no, then reply with only my answer.", async () => {
        escalatedQuestionWaits += 1;
        await pickFirstOption();
      });
      check("the risky question reached the operator as WAITING", escalatedQuestionWaits > 0);
      check("the manager escalated the risky question", managerEntries().some((entry) => entry.outcome === "escalated" && /delete/i.test(String(entry.reason))));
      return;
    }

    const writer = backend.getSession(whiteboardWriterIdFor(SESSION_ID));
    if (!writer) throw new Error("the probe config did not produce the board writer session");
    await queueWhiteboardEditFor(backend, session, writer);
    const whiteboardOutputOffset = session.getOutputOffset();
    const whiteboardHooks = await runScenario("whiteboard-prompt-context", WHITEBOARD_PROBE_PROMPT, approveOnce);
    check("UserPromptSubmit reached the hooks", hookEventsOf(whiteboardHooks).includes("userpromptsubmit"));
    check("the queued board edit reached the model with the prompt", screenShowsWhiteboardAnswer(session.getBufferSince(whiteboardOutputOffset).data));

    const questionHooks = await runScenario("ask-question", QUESTION_PROMPT, pickFirstOption);
    check("the question form reached the hooks as Elicitation then ElicitationResult", hookEventsOf(questionHooks).join(",").includes("elicitation,elicitationresult"));
    check("the question form carried the AskUserQuestion call", questionHooks.some((hook) => hook.event.toLowerCase() === "elicitation" && hook.payload?.tool_name === "AskUserQuestion"));

    const planHooks = await runScenario("plan-wait", PLAN_PROMPT, pickFirstOption, 5000);
    check("the plan approval waited on the operator", hookEventsOf(planHooks).includes("elicitation"));
    check("the plan turn ended on Stop", hookEventsOf(planHooks).includes("stop"));

    const completionsBeforeSubagent = completions.length;
    const subagentHooks = await runScenario("subagent", "Use the task tool to start one general subagent that runs ls in the current directory and reports the file names. Wait for it, then reply with the single word done.", approveOnce, SUBAGENT_SETTLE_MS);
    const subagentEvents = hookEventsOf(subagentHooks);
    check("the subagent started and stopped inside the turn", subagentEvents.includes("subagentstart") && subagentEvents.indexOf("subagentstop") > subagentEvents.indexOf("subagentstart"));
    check("the subagent turn completed the card exactly once", completions.length - completionsBeforeSubagent === 1);

    await runBackgroundSelfWake();

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
    console.log(`  [clear] SessionStart sources: ${JSON.stringify(clearHooks.filter((hook) => hook.event.toLowerCase() === "sessionstart").map((hook) => hook.payload?.source ?? null))}`);
    const clearedId = session._resumeSessionId;
    check("/new moved the card to the new session id", typeof clearedId === "string" && clearedId !== capturedId);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const turnHooks = await runScenario("turn-complete", `reply with the single word ${SENTINEL_WORD} and nothing else`, approveOnce);
    check("the resumed turn ended on Stop", hookEventsOf(turnHooks).includes("stop"));
    check("resume kept the same session id", session._resumeSessionId === clearedId);
    for (const [index, launch] of launches.entries()) console.log(`  [argv:${index + 1}] ${JSON.stringify(launch.args)}`);
    check("the resumed argv carried --session with the captured id", !!clearedId && launches.at(-1)?.args.join(" ").includes(`--session ${clearedId}`) === true);

    await runResumeContinueProbe({ session, hookRecords, fixtureTarget, check, answerWaiting: approveOnce, submitFirstTurn: null });
  } finally {
    session.kill();
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await closeServer(server);
  }
}

async function main(): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-opencode-probe-"));
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

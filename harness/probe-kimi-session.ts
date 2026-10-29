import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createBackend } from "../server/backend/backend.ts";
import kimi from "../session/adapters/kimi.ts";
import { generatedKimiHomePath } from "../session/kimi-home.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { createProbeChecks, delay, hookEventsOf, waitForState, writeHookFixture } from "./support/backend-harness.ts";
import type { ProbeFixtureTarget, ProbeHookRecord } from "./support/backend-harness.ts";

interface SpawnCall {
  file: string;
  args: string[];
}

const SESSION_ID = "kimi-probe-session";
const SENTINEL_WORD = "copperheron";
const BOOT_SETTLE_MS = 8000;
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const OPERATOR_KIMI_HOME = path.join(os.homedir(), ".kimi-code");
const LINKED_LOGIN_ENTRIES = ["credentials", "device_id", "region.json"];

const { check, passed, failed } = createProbeChecks();

function makeProbeKimiHome(tempDirectory: string): string {
  const kimiHome = path.join(tempDirectory, "kimi-home");
  fs.mkdirSync(kimiHome, { mode: 0o700 });
  const operatorConfig = path.join(OPERATOR_KIMI_HOME, "config.toml");
  if (!fs.existsSync(operatorConfig)) throw new Error("Kimi Code is not configured. Run kimi login outside this probe, then run it again.");
  fs.copyFileSync(operatorConfig, path.join(kimiHome, "config.toml"));
  fs.chmodSync(path.join(kimiHome, "config.toml"), 0o600);
  for (const entry of LINKED_LOGIN_ENTRIES) {
    const source = path.join(OPERATOR_KIMI_HOME, entry);
    if (fs.existsSync(source)) fs.symlinkSync(source, path.join(kimiHome, entry));
  }
  return kimiHome;
}

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "kimi probe",
      path: projectDirectory,
      agent: "kimi",
      dangerouslySkipPermissions: false,
    }],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktreeAutoRebase: false,
    capture: { enabled: true },
  }, null, 2), "utf8");
}

async function runProbe(tempDirectory: string): Promise<void> {
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.KIMI_CODE_HOME = makeProbeKimiHome(tempDirectory);
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, "glimmervoid-home");

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const fixtureTarget: ProbeFixtureTarget = {
    agentId: "kimi",
    tempDirectory,
    keepDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-kimi-probe-out-")),
    shouldWriteFixtures: SHOULD_WRITE_FIXTURES,
  };
  const hookRecords: ProbeHookRecord[] = [];
  const completions: number[] = [];
  const spawnCalls: SpawnCall[] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    spawnCalls.push({ file, args: [...spawnArgs] });
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session.on("state-change", ({ from, to, event }: { from: string; to: string; event: string }) => {
    console.log(`  [state] ${from} -> ${to} (${event})`);
    if (to !== "COMPLETE") return;
    completions.push(hookRecords.length);
    for (const decision of session._observability.decisionTail(4)) console.log(`  [decision] ${JSON.stringify(decision)}`);
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
    const scenarioHooks = hookRecords.slice(scenarioStart);
    console.log(`  [fixture] ${writeHookFixture(name, scenarioHooks, fixtureTarget)}`);
    console.log(`  [events] ${hookEventsOf(scenarioHooks).join(", ")}`);
    return scenarioHooks;
  }

  async function typeCommand(command: string): Promise<void> {
    session.write(command);
    await delay(1200);
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

  try {
    console.log("\nSpawn into an untrusted folder:");
    const ptyWrites: string[] = [];
    const writeToPty = session.write.bind(session);
    session.write = (text: string) => {
      ptyWrites.push(text);
      writeToPty(text);
    };
    session._initialPrompt = "Run the shell command: touch ./kimi-probe-approval.txt";
    await session.start();
    check("the spawn used the kimi adapter", session.agentId === "kimi");
    await delay(BOOT_SETTLE_MS);
    check("the folder starts untrusted", !kimi.isWorkspaceTrusted(projectDirectory, { ...process.env, KIMI_CODE_HOME: generatedKimiHomePath() }));
    check("nothing was typed into the trust dialog", ptyWrites.length === 0);
    session.write("\r");
    await delay(3000);
    check("kimi's own trust record matches the computed key", kimi.isWorkspaceTrusted(projectDirectory, { ...process.env, KIMI_CODE_HOME: generatedKimiHomePath() }));
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "untrusted PTY reap");

    console.log("\nRespawn into the trusted folder:");
    ptyWrites.length = 0;
    check("restart requested a fresh spawn", session.restart());
    const approvalHooks = await runScenario("approval-turn", null, approveOnce);
    check("the initial prompt was pasted without operator input", ptyWrites.some((text) => text.includes("kimi-probe-approval.txt")));
    session._initialPrompt = null;
    const approvalEvents = hookEventsOf(approvalHooks);
    check("SessionStart fired on the first submitted prompt", approvalEvents[0] === "sessionstart");
    check("PermissionRequest preceded the turn's Stop", approvalEvents.indexOf("permissionrequest") >= 0 && approvalEvents.indexOf("permissionrequest") < approvalEvents.lastIndexOf("stop"));
    const capturedId = session._resumeSessionId;
    check("the captured session id is session_<uuid>", /^session_[0-9a-f-]{36}$/.test(String(capturedId || "")));

    const questionHooks = await runScenario("ask-question", "Use the AskUserQuestion tool to ask me whether I prefer red or blue, then reply with only my answer.", pickFirstOption);
    const questionEvents = hookEventsOf(questionHooks);
    check("AskUserQuestion reached the hooks as PreToolUse then PostToolUse", questionHooks.some((hook) => hook.event.toLowerCase() === "pretooluse" && hook.payload?.tool_name === "AskUserQuestion") && questionEvents.includes("posttooluse"));

    const completionsBeforeSubagent = completions.length;
    const subagentHooks = await runScenario("subagent", "Use the Agent tool to start one subagent that runs ls in the current directory and reports the file names. Wait for it, then reply with the single word done.", approveOnce, 20000);
    const subagentEvents = hookEventsOf(subagentHooks);
    const agentToolStop = subagentHooks.findIndex((hook) => hook.event.toLowerCase() === "posttooluse" && hook.payload?.tool_name === "Agent");
    check("a subagent Stop fired inside the open Agent tool call", subagentEvents.slice(0, Math.max(agentToolStop, 0)).includes("stop"));
    check("the subagent turn completed the card exactly once", completions.length - completionsBeforeSubagent === 1);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const resumeStart = hookRecords.length;
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    await waitForState(session, ["COMPLETE"], "resumed turn");
    check("resume kept the same session id", session._resumeSessionId === capturedId);
    const resumedStarts = hookRecords.slice(resumeStart).filter((hook) => hook.event.toLowerCase() === "sessionstart");
    console.log(`  [resume] SessionStart sources: ${JSON.stringify(resumedStarts.map((hook) => hook.payload?.source ?? null))}`);
    for (const [index, call] of spawnCalls.entries()) console.log(`  [argv:${index + 1}] ${JSON.stringify([call.file, ...call.args])}`);
    check("the resumed argv carried -S with the captured id", !!capturedId && spawnCalls[2]?.args.join(" ").includes(`-S ${capturedId}`));

    const turnHooks = await runScenario("turn-complete", `reply with the single word ${SENTINEL_WORD} and nothing else`, approveOnce);
    check("a plain turn ended on Stop", hookEventsOf(turnHooks).includes("stop"));

    console.log("\nidle-compaction:");
    const compactionStart = hookRecords.length;
    await typeCommand("/compact");
    check("PostCompact fired", await waitForHook("PostCompact", compactionStart, "postcompact"));
    await delay(3000);
    captureSince("idle-compaction", compactionStart);

    await typeCommand("/plan");
    await delay(2000);
    const planHooks = await runScenario("plan-wait", "Present a one-step plan to create plan.txt containing ok, then carry it out once approved.", approveOnce, 5000);
    check("the plan turn ended on Stop", hookEventsOf(planHooks).includes("stop"));

    console.log("\nsession-clear:");
    const clearStart = hookRecords.length;
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the turn before /clear ended on Stop", await waitForHook("Stop before /clear", clearStart, "stop"));
    await delay(3000);
    const clearCommandStart = hookRecords.length;
    const taskTitleResetsBeforeClear = taskTitleResets;
    await typeCommand("/clear");
    await delay(3000);
    await submit(`reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the first turn after /clear ended on Stop", await waitForHook("Stop after /clear", clearCommandStart, "stop"));
    check("SessionStart fired after /clear", await waitForHook("SessionStart after /clear", clearCommandStart, "sessionstart"));
    check("the card reset its task title on /clear", taskTitleResets > taskTitleResetsBeforeClear);
    await delay(3000);
    const clearHooks = captureSince("session-clear", clearStart);
    console.log(`  [clear] SessionStart sources: ${JSON.stringify(clearHooks.filter((hook) => hook.event.toLowerCase() === "sessionstart").map((hook) => hook.payload?.source ?? null))}`);
  } finally {
    session.kill();
    await delay(1500);
    backend.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

async function main(): Promise<void> {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-kimi-probe-"));
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

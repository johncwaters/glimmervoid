import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { runAgentSetupCli } from "../server/agent-setup-cli.ts";
import { createBackend } from "../server/backend/backend.ts";
import { projectHookPayload } from "../session/core/hook-payload-projection.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";

interface HookRecord {
  event: string;
  payload: HookPayload | null;
}

interface SpawnCall {
  file: string;
  args: string[];
}

const SESSION_ID = "kimi-probe-session";
const SENTINEL_WORD = "copperheron";
const STEP_TIMEOUT_MS = 120000;
const BOOT_SETTLE_MS = 8000;
const FIXTURE_DIR = path.join(import.meta.dirname, "..", "tests", "fixtures");
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const OPERATOR_KIMI_HOME = path.join(os.homedir(), ".kimi-code");
const LINKED_LOGIN_ENTRIES = ["credentials", "device_id", "region.json"];

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
    return;
  }
  console.error(`  FAIL  ${label}`);
  failed += 1;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function waitForState(session: Session, states: string[], label: string): Promise<string> {
  const wantedStates = new Set(states);
  if (wantedStates.has(session.state)) return Promise.resolve(session.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off("state-change", onStateChange);
      reject(new Error(`timed out waiting for ${label}, still ${session.state}`));
    }, STEP_TIMEOUT_MS);
    function onStateChange({ to }: { to: string }): void {
      if (!wantedStates.has(to)) return;
      clearTimeout(timer);
      session.off("state-change", onStateChange);
      resolve(to);
    }
    session.on("state-change", onStateChange);
  });
}

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

function sanitize(text: string, tempDirectory: string): string {
  return text.split(tempDirectory).join("<kimi-probe>").split(os.homedir()).join("<home>");
}

function writeHookFixture(name: string, hooks: HookRecord[], tempDirectory: string, keepDirectory: string): string {
  const header = { type: "header", version: 2, records: "signals", session: `fixture-kimi-${name}`, agent: "kimi", startedAt: 0, config: { hooksInjected: true } };
  const lines = [header, ...hooks.map((hook, index) => ({ type: "hook", ts: index + 1, event: hook.event, payload: projectHookPayload(hook.payload) }))];
  const destination = path.join(SHOULD_WRITE_FIXTURES ? FIXTURE_DIR : keepDirectory, `v2-kimi-${name}.jsonl`);
  fs.writeFileSync(destination, `${sanitize(lines.map((line) => JSON.stringify(line)).join("\n"), tempDirectory)}\n`, "utf8");
  return destination;
}

function eventsOf(hooks: HookRecord[]): string[] {
  return hooks.map((hook) => hook.event.toLowerCase());
}

async function runProbe(tempDirectory: string): Promise<void> {
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.KIMI_CODE_HOME = makeProbeKimiHome(tempDirectory);
  if (runAgentSetupCli(["setup", "kimi"]) !== 0) throw new Error("The isolated Kimi Code hook setup failed.");

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on("request", backend.app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const registeredSession: Session | null = backend.getSession(SESSION_ID);
  if (!registeredSession) throw new Error(`the probe config did not produce a session named ${SESSION_ID}`);
  const session: Session = registeredSession;
  const keepDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glimmervoid-kimi-probe-out-"));
  const hookRecords: HookRecord[] = [];
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
  session.on("hook-event", ({ event, payload }: { event: string; payload: HookPayload | null }) => {
    hookRecords.push({ event, payload: payload ?? null });
  });

  async function submit(prompt: string): Promise<void> {
    session.write(`\x1b[200~${prompt}\x1b[201~`);
    await delay(1200);
    session.write("\r");
  }

  async function runScenario(name: string, prompt: string, answerWaiting: () => Promise<void>, settleMs = 3000): Promise<HookRecord[]> {
    console.log(`\n${name}:`);
    const scenarioStart = hookRecords.length;
    await submit(prompt);
    await waitForState(session, ["RUNNING", "WAITING"], `${name} to start`);
    while ((await waitForState(session, ["COMPLETE", "WAITING"], `${name} to finish`)) === "WAITING") {
      console.log(`  [answer] ${name}`);
      await answerWaiting();
      await waitForState(session, ["RUNNING", "COMPLETE"], `${name} to resume`);
    }
    await delay(settleMs);
    const scenarioHooks = hookRecords.slice(scenarioStart);
    console.log(`  [fixture] ${writeHookFixture(name, scenarioHooks, tempDirectory, keepDirectory)}`);
    console.log(`  [events] ${eventsOf(scenarioHooks).join(", ")}`);
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
    console.log("\nSpawn:");
    await session.start();
    check("the spawn used the kimi adapter", session.agentId === "kimi");
    await delay(BOOT_SETTLE_MS);
    session.write("\r");
    await delay(3000);

    const approvalHooks = await runScenario("approval-turn", "Run the shell command: touch ./kimi-probe-approval.txt", approveOnce);
    const approvalEvents = eventsOf(approvalHooks);
    check("SessionStart fired on the first submitted prompt", approvalEvents[0] === "sessionstart");
    check("PermissionRequest preceded the turn's Stop", approvalEvents.indexOf("permissionrequest") >= 0 && approvalEvents.indexOf("permissionrequest") < approvalEvents.lastIndexOf("stop"));
    const capturedId = session._resumeSessionId;
    check("the captured session id is session_<uuid>", /^session_[0-9a-f-]{36}$/.test(String(capturedId || "")));

    const questionHooks = await runScenario("ask-question", "Use the AskUserQuestion tool to ask me whether I prefer red or blue, then reply with only my answer.", pickFirstOption);
    const questionEvents = eventsOf(questionHooks);
    check("AskUserQuestion reached the hooks as PreToolUse then PostToolUse", questionHooks.some((hook) => hook.event.toLowerCase() === "pretooluse" && hook.payload?.tool_name === "AskUserQuestion") && questionEvents.includes("posttooluse"));

    const completionsBeforeSubagent = completions.length;
    const subagentHooks = await runScenario("subagent", "Use the Agent tool to start one subagent that runs ls in the current directory and reports the file names. Wait for it, then reply with the single word done.", approveOnce, 20000);
    const subagentEvents = eventsOf(subagentHooks);
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
    check("the resumed argv carried -S with the captured id", !!capturedId && spawnCalls[1]?.args.join(" ").includes(`-S ${capturedId}`));
  } finally {
    try {
      session.kill();
    } catch {}
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

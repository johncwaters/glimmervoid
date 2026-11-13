import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBackend } from "../server/backend/backend.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { closeServer, createProbeChecks, delay, hookEventsOf, waitForState, writeHookFixture } from "./support/backend-harness.ts";
import type { ProbeFixtureTarget, ProbeHookRecord } from "./support/backend-harness.ts";

interface SpawnCall {
  args: string[];
  env: Record<string, string | undefined>;
}

const SESSION_ID = "opencode-probe-session";
const SENTINEL_WORD = "copperheron";
const APPROVAL_FILE_NAME = "opencode-probe-approval.txt";
const BOOT_SETTLE_MS = 8000;
const SUBAGENT_SETTLE_MS = 15000;
const COMPACTION_SETTLE_MS = 40000;
const PROBE_MODEL = process.env.GLIMMERVOID_OPENCODE_PROBE_MODEL ?? "anthropic/claude-haiku-4-5";
const SHOULD_WRITE_FIXTURES = process.argv.includes("--write-fixtures");
const XDG_DIRECTORY_ENV_NAMES = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

const { check, passed, failed } = createProbeChecks();

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{ id: SESSION_ID, name: "opencode probe", path: projectDirectory, agent: "opencode", dangerouslySkipPermissions: false }],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktree: { autoRebase: false },
    capture: { enabled: true },
  }, null, 2), "utf8");
}

function isolateOpenCode(tempDirectory: string): void {
  for (const envName of XDG_DIRECTORY_ENV_NAMES) {
    const directory = path.join(tempDirectory, "opencode-home", envName.toLowerCase());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    process.env[envName] = directory;
  }
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: PROBE_MODEL, permission: { bash: "ask", edit: "ask" } });
}

async function runProbe(tempDirectory: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY && PROBE_MODEL.startsWith("anthropic/")) throw new Error("set ANTHROPIC_API_KEY, or GLIMMERVOID_OPENCODE_PROBE_MODEL to a model OpenCode can reach");
  const projectDirectory = path.join(tempDirectory, "project");
  fs.mkdirSync(projectDirectory);
  const configPath = path.join(tempDirectory, "config.json");
  writeProbeConfig(configPath, projectDirectory);
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(tempDirectory, "glimmervoid-home");
  isolateOpenCode(tempDirectory);

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
  const spawnCalls: SpawnCall[] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    spawnCalls.push({ args: [...spawnArgs], env: { ...spawnOptions.env } });
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
    console.log("\nSpawn:");
    session._initialPrompt = `Run the shell command: touch ./${APPROVAL_FILE_NAME}`;
    await session.start();
    check("the spawn used the opencode adapter", session.agentId === "opencode");
    const launchConfig: unknown = JSON.parse(spawnCalls[0]?.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const launchPlugins = typeof launchConfig === "object" && launchConfig !== null && "plugins" in launchConfig && Array.isArray(launchConfig.plugins) ? launchConfig.plugins.map(String) : [];
    const pluginFolder = launchPlugins.map((entry) => entry.startsWith("file:") ? fileURLToPath(entry) : "").find((folder) => folder.startsWith(String(process.env.GLIMMERVOID_HOME))) ?? null;
    check("OPENCODE_CONFIG_CONTENT loaded the generated plugin folder", !!pluginFolder && fs.existsSync(path.join(pluginFolder, "index.js")));
    check("OPENCODE_CONFIG_CONTENT kept the operator's own settings", typeof launchConfig === "object" && launchConfig !== null && "model" in launchConfig && launchConfig.model === PROBE_MODEL);
    check("OPENCODE_CONFIG_DIR was left alone", spawnCalls[0]?.env.OPENCODE_CONFIG_DIR === undefined);
    check("the launch ran a private server", !!spawnCalls[0]?.args.includes("--standalone"));
    const approvalHooks = await runScenario("approval-turn", null, approveOnce);
    session._initialPrompt = null;
    const approvalEvents = hookEventsOf(approvalHooks);
    check("SessionStart fired first", approvalEvents[0] === "sessionstart");
    check("PermissionRequest preceded the turn's Stop", approvalEvents.indexOf("permissionrequest") >= 0 && approvalEvents.indexOf("permissionrequest") < approvalEvents.lastIndexOf("stop"));
    check("the approved command ran", fs.existsSync(path.join(projectDirectory, APPROVAL_FILE_NAME)));
    const capturedId = session._resumeSessionId;
    check("the captured session id is an OpenCode ses_ id", /^ses_[0-9A-Za-z]+$/.test(String(capturedId || "")));

    const questionHooks = await runScenario("ask-question", "Use your question tool to ask me whether I prefer red or blue, then reply with only my answer.", pickFirstOption);
    check("the question form reached the hooks as Elicitation then ElicitationResult", hookEventsOf(questionHooks).join(",").includes("elicitation,elicitationresult"));

    const completionsBeforeSubagent = completions.length;
    const subagentHooks = await runScenario("subagent", "Use the task tool to start one general subagent that runs ls in the current directory and reports the file names. Wait for it, then reply with the single word done.", approveOnce, SUBAGENT_SETTLE_MS);
    const subagentEvents = hookEventsOf(subagentHooks);
    check("the subagent started and stopped inside the turn", subagentEvents.includes("subagentstart") && subagentEvents.indexOf("subagentstop") > subagentEvents.indexOf("subagentstart"));
    check("the subagent turn completed the card exactly once", completions.length - completionsBeforeSubagent === 1);

    console.log("\nidle-compaction:");
    const compactionStart = hookRecords.length;
    const completionsBeforeCompaction = completions.length;
    session.write("/compact");
    await delay(1500);
    session.write("\r");
    await delay(COMPACTION_SETTLE_MS);
    const compactionEvents = hookEventsOf(captureSince("idle-compaction", compactionStart));
    check("an idle compaction relayed only PreCompact and PostCompact", compactionEvents.join(",") === "precompact,postcompact");
    check("the idle compaction left the card COMPLETE without a new completion", session.state === "COMPLETE" && completions.length === completionsBeforeCompaction);

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const turnHooks = await runScenario("turn-complete", `reply with the single word ${SENTINEL_WORD} and nothing else`, approveOnce);
    check("the resumed turn ended on Stop", hookEventsOf(turnHooks).includes("stop"));
    check("resume kept the same session id", session._resumeSessionId === capturedId);
    for (const [index, call] of spawnCalls.entries()) console.log(`  [argv:${index + 1}] ${JSON.stringify(call.args)}`);
    check("the resumed argv carried --session with the captured id", !!capturedId && spawnCalls[1]?.args.join(" ").includes(`--session ${capturedId}`) === true);
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

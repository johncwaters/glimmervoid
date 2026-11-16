import "./support/disable-telemetry.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createBackend } from "../server/backend/backend.ts";
import type { Session } from "../session/sessions.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import {
  closeServer, createProbeChecks, delay, hookEventsOf, waitForState, writeHookFixture,
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

const { check, passed, failed } = createProbeChecks();

function writeProbeConfig(configPath: string, projectDirectory: string): void {
  fs.writeFileSync(configPath, JSON.stringify({
    projects: [{
      id: SESSION_ID,
      name: "antigravity probe",
      path: projectDirectory,
      agent: AGENT_ID,
      dangerouslySkipPermissions: false,
    }],
    teams: [],
    repoRoots: [],
    autoResume: false,
    worktree: { autoRebase: false },
    capture: { enabled: true },
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
  };
  const hookRecords: ProbeHookRecord[] = [];
  const launches: ProbeLaunch[] = [];
  const spawnPty = session._ptySpawn;
  session._ptySpawn = (file, spawnArgs, spawnOptions) => {
    launches.push({ args: [...spawnArgs], env: { ...spawnOptions.env } });
    return spawnPty(file, spawnArgs, spawnOptions);
  };
  session.on("state-change", ({ from, to, event }: { from: string; to: string; event: string }) => {
    console.log(`  [state] ${from} -> ${to} (${event})`);
  });
  session.on("hook-event", ({ event, payload }: { event: string; payload: HookPayload | null }) => {
    hookRecords.push({ event, payload: payload ?? null });
  });

  async function submit(prompt: string): Promise<void> {
    session.write(`\x1b[200~${prompt}\x1b[201~`);
    await delay(1200);
    session.write("\r");
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

    console.log("\nResume:");
    session.kill();
    await waitForState(session, ["DONE", "FAILED"], "PTY reap");
    check("restart requested a resumed spawn", session.restart());
    await delay(BOOT_SETTLE_MS);
    const turnHooks = await runScenario("turn-complete", `reply with the single word ${SENTINEL_WORD} and nothing else`);
    check("the resumed turn ended on Stop", hookEventsOf(turnHooks).includes("stop"));
    check("resume kept the same conversation id", session._resumeSessionId === capturedId);
    check("the resumed argv carried --conversation with the captured id", !!capturedId && launches.at(-1)?.args.join(" ").includes(`--conversation ${capturedId}`) === true);
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

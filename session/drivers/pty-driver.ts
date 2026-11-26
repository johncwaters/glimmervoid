import pty from "node-pty";
import { assertLaunchable } from "../../server/child-process-safe.ts";
import { requireExecutableSpawnHelper } from "../../server/node-pty-preflight.ts";
import { requireRelayExecutable } from "../../server/runtime-paths.ts";
import { errorMessage } from "../../shared/text.ts";
import { NO_INPUT_READY_SCAN, scanInputReady } from "../core/input-ready-core.ts";
import type { InputReadyCondition } from "../core/input-ready-core.ts";
import { isBenignPtySocketError } from "../core/pty-socket-error-core.ts";
import { scanTerminalColorQueries } from "../core/terminal-color-query.ts";
import type { TerminalColors } from "../core/terminal-color-query.ts";
import { LONE_ESCAPE } from "../core/waiting-input-core.ts";
import { createSessionOutput } from "../session-output.ts";
import type { SessionOutputOptions } from "../session-output.ts";
import { signalWindowChangeBelow } from "../window-change-signal.ts";
import type { DriverEvent, DriverLaunch, DriverListener, SessionDriver } from "./driver.ts";

interface SessionPty {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  _agent?: { inSocket?: { on: (event: string, listener: (error: Error) => void) => unknown } };
  on?: (event: string, listener: (error: Error) => void) => unknown;
}

type PtySpawn = (
  file: string,
  args: string[],
  options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions,
) => SessionPty;

type PtyLifecycle = "idle" | "live" | "exited";

interface PtyHandle {
  pid: number;
  scopeUnit: string | null;
}

interface PtyDriverOptions extends Omit<SessionOutputOptions, "hasLivePty"> {
  sessionId: string;
  spawn: PtySpawn | null;
  platform: () => NodeJS.Platform;
  inputReadyCondition: () => InputReadyCondition | undefined;
  isInputReady: () => boolean;
  noteInputReady: () => void;
  noteOutput: (data: string) => void;
  feedTitle: (data: string) => void;
  terminalColors: () => TerminalColors;
  signalsWindowChange: () => boolean;
  killTree: (pid: number) => void;
  onSocketFailure: () => void;
}

interface PtyDriver extends SessionDriver {
  readonly output: ReturnType<typeof createSessionOutput>;
  readonly process: SessionPty | null;
  readonly isMarkedLive: boolean;
  adoptProcess(process: SessionPty | null): void;
  setLive(isLive: boolean): void;
  currentHandle(): PtyHandle | null;
  forget(): void;
  markExited(): void;
  streamOutput(): void;
  handleOutput(data: string): void;
  write(text: string): boolean;
  resize(cols: number, rows: number): number | null;
  ptySize(): { cols: number; rows: number; seq: number };
  resetForStart(): void;
  spawnFunction(): PtySpawn;
  useSpawnFunction(spawn: PtySpawn): void;
  spawnsWithNodePty(): boolean;
}

function createPtyDriver(options: PtyDriverOptions): PtyDriver {
  const listeners = new Set<DriverListener>();
  let ptyProcess: SessionPty | null = null;
  let scopeUnit: string | null = null;
  let lifecycle: PtyLifecycle = "idle";
  let resizeSeq = 0;
  let pendingColorQuery = "";
  let inputReadyScan = NO_INPUT_READY_SCAN;

  const spawnWithNodePty: PtySpawn = (file, args, spawnOptions) => {
    requireExecutableSpawnHelper();
    requireRelayExecutable();
    assertLaunchable(file);
    return pty.spawn(file, args, spawnOptions);
  };
  let spawnFunction: PtySpawn = options.spawn || spawnWithNodePty;

  function isLive(): boolean {
    return ptyProcess !== null && lifecycle === "live";
  }

  const output = createSessionOutput({
    ...options,
    hasLivePty: () => !options.isDestroyed() && isLive(),
  });

  function emit(event: DriverEvent): void {
    for (const listener of listeners) listener(event);
  }

  function handleSocketError(error: unknown): void {
    if (isBenignPtySocketError(error)) return;
    if (lifecycle !== "live") return;
    console.warn(`[session ${options.sessionId}] pty socket error: ${errorMessage(error)} - killing the session`);
    options.onSocketFailure();
  }

  function guardInputSocket(): void {
    try {
      ptyProcess?._agent?.inSocket?.on("error", (error) => {
        console.warn(`[session ${options.sessionId}] pty input socket error (ignored): ${error.message}`);
      });
    } catch {

    }
  }

  function guardUnixSocket(): void {
    if (options.platform() === "win32") return;
    try {
      ptyProcess?.on?.("error", (error) => handleSocketError(error));
    } catch {

    }
  }

  function start(launch: DriverLaunch): void {
    const size = output.ptySize();
    const spawned = spawnFunction(launch.file, launch.args, {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: launch.cwd,
      env: launch.env,
    });
    ptyProcess = spawned;
    scopeUnit = launch.scopeUnit;
    lifecycle = "live";
    guardInputSocket();
    guardUnixSocket();
    spawned.onExit(({ exitCode, signal }) => emit({ kind: "exit", exitCode, signal }));
  }

  function streamOutput(): void {
    ptyProcess?.onData((data) => handleOutput(data));
  }

  function scanForInputReady(data: string): void {
    if (options.isInputReady()) return;
    const { isReady, scan } = scanInputReady(options.inputReadyCondition(), inputReadyScan, data);
    inputReadyScan = scan;
    if (isReady) options.noteInputReady();
  }

  function answerColorQueries(data: string): void {
    const scan = scanTerminalColorQueries(pendingColorQuery, data, options.terminalColors());
    pendingColorQuery = scan.pending;
    for (const reply of scan.replies) options.write(reply);
  }

  function handleOutput(data: string): void {
    if (options.isDestroyed()) return;
    options.noteOutput(data);
    scanForInputReady(data);
    options.feedTitle(data);
    answerColorQueries(data);
    output.push(data);
    emit({ kind: "output", data });
  }

  function write(text: string): boolean {
    if (!ptyProcess || lifecycle !== "live") return false;
    ptyProcess.write(text);
    return true;
  }

  function resize(cols: number, rows: number): number | null {
    if (!output.rememberSize(cols, rows)) return null;
    if (ptyProcess) {
      try {
        ptyProcess.resize(cols, rows);
      } catch {}
      if (options.signalsWindowChange()) void signalWindowChangeBelow(ptyProcess.pid);
    }
    resizeSeq += 1;
    return resizeSeq;
  }

  function stop(): boolean {
    if (!ptyProcess) return false;
    lifecycle = "exited";
    options.killTree(ptyProcess.pid);
    return true;
  }

  return {
    hasTerminal: true,
    get pid() { return ptyProcess ? ptyProcess.pid : null; },
    get isLive() { return isLive(); },
    get process() { return ptyProcess; },
    get isMarkedLive() { return lifecycle === "live"; },
    output,
    start,
    send: (text, deliverOptions) => output.deliver(text, deliverOptions),
    interrupt: () => { write(LONE_ESCAPE); },
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    adoptProcess(process) { ptyProcess = process; },
    setLive(isLiveNow) { lifecycle = isLiveNow ? "live" : "exited"; },
    currentHandle: () => (ptyProcess ? { pid: ptyProcess.pid, scopeUnit } : null),
    forget() {
      ptyProcess = null;
      scopeUnit = null;
    },
    markExited() { lifecycle = "exited"; },
    streamOutput,
    handleOutput,
    write,
    resize,
    ptySize() {
      const size = output.ptySize();
      return { cols: size.cols, rows: size.rows, seq: resizeSeq };
    },
    resetForStart() {
      inputReadyScan = NO_INPUT_READY_SCAN;
      output.reset();
    },
    spawnFunction: () => spawnFunction,
    useSpawnFunction(spawn) { spawnFunction = spawn; },
    spawnsWithNodePty: () => spawnFunction === spawnWithNodePty,
  };
}

export { createPtyDriver };
export type { PtyDriver, PtySpawn, SessionPty };

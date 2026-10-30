import { errorMessage, isMissingFileError } from "../shared/text.ts";
import fs from "node:fs";
import path from "node:path";
import { writeSessionSettings, generateToken } from "../detection/settings-injector.ts";
import type { HookRegistration, HookSignal } from "../detection/hook-source.ts";
import { HOOK_URL_ENV } from "./core/hook-relay-core.ts";
import { HOOK_TOOLS } from "./core/hook-tools.ts";
import type { ResolvedHookTool } from "./core/hook-tools.ts";
import { saneYoloHomeDir } from "../server/hook-tools.ts";
import type { UserHook } from "./core/user-hooks-core.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import { hookProfileOf } from "./adapters/index.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import type {
  AgentAdapter,
  AgentHookProfile,
  ArgvConfigInjection,
  GeneratedHomeInjection,
  ScratchAgentHome,
  HomeHooksFileInjection,
  HookedAgentHome,
  ProjectConfigCandidate,
} from "./adapters/index.ts";

interface HookInjectionResult {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  isSaneYoloActive: boolean;
  refusal?: string;
}

const NO_HOOK_INJECTION: HookInjectionResult = Object.freeze({
  args: Object.freeze<string[]>([]),
  env: Object.freeze<Record<string, string>>({}),
  isSaneYoloActive: false,
});
const MAX_PROJECT_CONFIG_DEPTH = 12;

interface HookRouterPort {
  register(glimmervoidId: string, registration: HookRegistration): void;
  unregister(glimmervoidId: string): void;
}

interface SessionHookOptions {
  id: string;
  name: string;
  agentId: string;
  adapter: AgentAdapter;
  hookRouter: HookRouterPort | null;
  getHookPort: (() => number | null) | null;
  hooksBaseDir: string | undefined;
  settingsPermissions: Record<string, unknown> | null;
  detectScheduledWakeups: boolean;
  observeToolCalls: boolean;
  enableProjectMcp: boolean;
  hookTools: ResolvedHookTool[];
  planLimits: boolean;
  planReview: boolean;
  holdsQuestionsForParent: boolean;
  getUserHooks?: (() => UserHook[]) | null;
  extraUserHooks?: UserHook[];
  scratchAgentHome?: ScratchAgentHome | null;
  requiresHooks: boolean;
  bypassHookTrust: boolean;
  effectiveCwd: () => string;
  agentEnv: () => Record<string, string | undefined>;
  ingestSignal: (signal: HookSignal) => void;
  observeHook: ((event: string, payload: Record<string, unknown>) => void) | null;
  recordDecision: (entry: DecisionEntry) => void;
}

interface SessionHookLifecycle {
  prepare(): Promise<void>;
  inject(): HookInjectionResult;
  cleanup(): void;
  token(): string | null;
  listenerPort(): number | null;
  hasInjection(): boolean;
  hasSettings(): boolean;
}

function payloadEnricherFor(hookProfile: AgentHookProfile | null, agentEnv: () => Record<string, string | undefined>) {
  const enrichPayload = hookProfile?.enrichPayload;
  if (!enrichPayload) return null;
  return (event: string, payload: HookPayload) => enrichPayload(event, payload, agentEnv());
}

function createSessionHookLifecycle(options: SessionHookOptions): SessionHookLifecycle {
  let token: string | null = null;
  let settingsHandle: ReturnType<typeof writeSessionSettings> | null = null;
  let hasWarnedSaneYoloHookMissing = false;
  let heldGeneratedHome: { releaseHome: (home: string) => void; home: string } | null = null;

  function saneYoloTool(): ResolvedHookTool | undefined {
    return options.hookTools.find((tool) => tool.id === "saneYolo");
  }

  function injectedHookTools(isSaneYoloActive: boolean): ResolvedHookTool[] {
    return options.hookTools.filter((tool) => tool.id !== "saneYolo" || isSaneYoloActive);
  }

  function hookToolEnv(isSaneYoloActive: boolean): Record<string, string> {
    return Object.assign({}, ...injectedHookTools(isSaneYoloActive).map((tool) => HOOK_TOOLS[tool.id].env(tool, saneYoloHomeDir())));
  }

  function releaseGeneratedHome(): void {
    if (!heldGeneratedHome) return;
    heldGeneratedHome.releaseHome(heldGeneratedHome.home);
    heldGeneratedHome = null;
  }

  function cleanup(): void {
    releaseGeneratedHome();
    if (!token && !settingsHandle) return;
    if (options.hookRouter) {
      try { options.hookRouter.unregister(options.id); } catch {}
    }
    if (settingsHandle) {
      try { settingsHandle.cleanup(); } catch {}
      settingsHandle = null;
    }
    token = null;
  }

  function findProjectAgentConfig(
    candidates: readonly ProjectConfigCandidate[],
    userConfigFolders: readonly string[],
    mayContributeHooks: ((contents: string) => boolean) | undefined,
  ): string | null {
    const resolvedUserConfigFolders = new Set(userConfigFolders.map((folder) => path.resolve(folder)));
    let directory = options.effectiveCwd();
    for (let depth = 0; depth < MAX_PROJECT_CONFIG_DEPTH; depth += 1) {
      for (const { relPath, presenceIsHit } of candidates) {
        const candidate = path.join(directory, relPath);
        if (resolvedUserConfigFolders.has(path.resolve(path.dirname(candidate)))) continue;
        if (presenceIsHit) {
          if (fs.existsSync(candidate)) return candidate;
          continue;
        }
        let contents: string | null = null;
        try {
          contents = fs.readFileSync(candidate, "utf8");
        } catch (error) {
          if (!isMissingFileError(error)) return candidate;
          continue;
        }
        if (typeof mayContributeHooks === "function" && mayContributeHooks(contents)) return candidate;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  }

  function decideTrustBypass(injection: ArgvConfigInjection): boolean {
    if (!options.bypassHookTrust) return false;
    const candidates = injection.projectConfigCandidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return true;
    const found = findProjectAgentConfig(candidates, injection.userConfigFolders(options.agentEnv()), injection.mayContributeHooks);
    if (!found) return true;
    console.warn(`[session:${options.name}] hook-trust bypass refused: ${found} could contribute hooks Glimmervoid did not write - falling back to OSC title only`);
    options.recordDecision({ kind: "hook-trust", ts: Date.now(), decision: "bypass-refused", reason: "project agent config could contribute hooks" });
    return false;
  }

  function registerRelayHooks(
    port: number,
    args: string[],
    isSaneYoloActive: boolean,
  ): HookInjectionResult {
    if (!options.hookRouter) return NO_HOOK_INJECTION;
    const nextToken = generateToken();
    const hookUrl = `http://127.0.0.1:${port}/hook/${encodeURIComponent(options.id)}?t=${encodeURIComponent(nextToken)}`;
    try {
      token = nextToken;
      options.hookRouter.register(options.id, {
        token,
        onSignal: options.ingestSignal,
        onEvent: options.observeHook,
        hooks: hookProfileOf(options.adapter),
        enrichPayload: payloadEnricherFor(hookProfileOf(options.adapter), options.agentEnv),
      });
      return { args, env: { [HOOK_URL_ENV]: hookUrl, ...hookToolEnv(isSaneYoloActive) }, isSaneYoloActive };
    } catch (error) {
      console.warn(`[session:${options.name}] hook injection failed: ${errorMessage(error)} - falling back to OSC title only`);
      cleanup();
      return NO_HOOK_INJECTION;
    }
  }

  function argvCarriesSaneYoloHook(args: readonly string[], relayPath: string): boolean {
    const tool = saneYoloTool();
    if (!tool) return false;
    const saneYoloGroup = HOOK_TOOLS.saneYolo.codexGroup(tool, relayPath);
    if (!saneYoloGroup) return false;
    return args.some((arg) => arg.includes(saneYoloGroup));
  }

  function glimmervoidSuppliedHooks(): UserHook[] {
    return [...(options.extraUserHooks ?? [])];
  }

  function holdHookedHome(home: HookedAgentHome): { home: string; isTrusted: boolean } | { refusal: string } {
    const prepared = home.prepareHome(process.env);
    if ("refusal" in prepared) return prepared;
    heldGeneratedHome = { releaseHome: home.releaseHome, home: prepared.home };
    return prepared;
  }

  function injectRelayHooks(port: number, injection: ArgvConfigInjection): HookInjectionResult {
    releaseGeneratedHome();
    const hookedHome = injection.home ? holdHookedHome(injection.home) : null;
    if (hookedHome && "refusal" in hookedHome) return { ...NO_HOOK_INJECTION, refusal: `${options.agentId} cannot start: ${hookedHome.refusal}` };
    const isTrustBypassed = decideTrustBypass(injection);
    const args = injection.buildHookArgs({
      bypassHookTrust: isTrustBypassed,
      hookTools: options.hookTools,
      userHooks: glimmervoidSuppliedHooks(),
      observeToolCalls: options.observeToolCalls,
      hasHomeHooks: hookedHome !== null,
    });
    if (!args) {
      releaseGeneratedHome();
      console.warn(`[session:${options.name}] hook injection skipped: the relay path cannot be expressed for ${options.agentId} - falling back to OSC title only`);
      return NO_HOOK_INJECTION;
    }
    const doesHomeRunHooks = hookedHome !== null && (hookedHome.isTrusted || isTrustBypassed);
    const doesArgvRunSaneYolo = isTrustBypassed && argvCarriesSaneYoloHook(args, injection.relayPath);
    const relayHooks = registerRelayHooks(port, args, saneYoloTool() !== undefined && (doesHomeRunHooks || doesArgvRunSaneYolo));
    if (relayHooks === NO_HOOK_INJECTION) {
      releaseGeneratedHome();
      return relayHooks;
    }
    if (!injection.home || !hookedHome) return relayHooks;
    return { ...relayHooks, env: { ...relayHooks.env, [injection.home.homeEnvName]: hookedHome.home } };
  }

  function warnIfSaneYoloHookMissing(hooksPath: string, contents: string, injection: HomeHooksFileInjection): void {
    if (hasWarnedSaneYoloHookMissing) return;
    if (!saneYoloTool()) return;
    if (injection.isSaneYoloReady(contents)) return;
    hasWarnedSaneYoloHookMissing = true;
    console.warn(`[session:${options.name}] Sane YOLO is not active: ${hooksPath} has no Sane YOLO PreToolUse hook; run "${injection.setupCommand}"`);
  }

  function injectHomeRelayHooks(port: number, injection: HomeHooksFileInjection): HookInjectionResult {
    const contributingConfig = findProjectAgentConfig(
      injection.projectConfigCandidates,
      injection.userConfigFolders(options.agentEnv()),
      injection.mayContributeHooks,
    );
    if (contributingConfig) {
      console.warn(`[session:${options.name}] home hook injection refused: ${contributingConfig} could contribute hooks Glimmervoid did not write - falling back to OSC title only`);
      options.recordDecision({
        kind: "hook-trust",
        ts: Date.now(),
        decision: "injection-refused",
        reason: "Claude compatibility settings could contribute hooks",
      });
      return NO_HOOK_INJECTION;
    }
    let hooksPath: string | null = null;
    let contents: string | null = null;
    try {
      const resolvedHooksPath = injection.filePath(process.env);
      hooksPath = resolvedHooksPath;
      contents = fs.readFileSync(resolvedHooksPath, "utf8");
    } catch (error) {
      const reason = isMissingFileError(error, { includeNotDir: false }) ? "not installed" : errorMessage(error);
      console.warn(`[session:${options.name}] ${options.agentId} hook injection skipped: ${reason}; run "${injection.setupCommand}"`);
      return NO_HOOK_INJECTION;
    }
    const classification = injection.classifyContents(contents);
    if (classification !== "current") {
      console.warn(`[session:${options.name}] ${options.agentId} hook injection skipped: ${hooksPath} is ${classification}; run "${injection.setupCommand}"`);
      return NO_HOOK_INJECTION;
    }
    warnIfSaneYoloHookMissing(hooksPath, contents, injection);
    const isSaneYoloHookInFile = injection.isSaneYoloReady(contents);
    return registerRelayHooks(port, [], saneYoloTool() !== undefined && isSaneYoloHookInFile);
  }

  function injectGeneratedHomeHooks(port: number, injection: GeneratedHomeInjection): HookInjectionResult {
    releaseGeneratedHome();
    const prepared = options.scratchAgentHome ? injection.prepareScratchHome(process.env, options.scratchAgentHome) : injection.prepareHome(process.env);
    if ("refusal" in prepared) return { ...NO_HOOK_INJECTION, refusal: `${options.agentId} cannot start: ${prepared.refusal}` };
    if (!options.scratchAgentHome) heldGeneratedHome = { releaseHome: injection.releaseHome, home: prepared.home };
    const relayHooks = registerRelayHooks(port, [], saneYoloTool() !== undefined);
    if (relayHooks === NO_HOOK_INJECTION) {
      releaseGeneratedHome();
      return { ...NO_HOOK_INJECTION, refusal: `${options.agentId} cannot start: its hooks could not be registered` };
    }
    return { ...relayHooks, env: { ...relayHooks.env, [injection.homeEnvName]: prepared.home } };
  }

  function resolveListenerPort(): number | null {
    if (!options.getHookPort) return null;
    try {
      return options.getHookPort() || null;
    } catch {
      return null;
    }
  }

  async function prepare(): Promise<void> {
    const injection = hookProfileOf(options.adapter)?.injection;
    if (injection?.kind !== "argv-config" || !injection.home || !options.hookRouter || !options.getHookPort) return;
    await injection.home.readTrust();
  }

  function inject(): HookInjectionResult {
    const injected = injectHooks();
    if (!options.requiresHooks || injected.refusal || injected.isSaneYoloActive) return injected;
    cleanup();
    return { ...NO_HOOK_INJECTION, refusal: `${options.agentId} cannot start: Sane YOLO hooks could not be injected` };
  }

  function injectHooks(): HookInjectionResult {
    const hookProfile = hookProfileOf(options.adapter);
    if (!hookProfile || !options.hookRouter || !options.getHookPort) return NO_HOOK_INJECTION;
    const port = resolveListenerPort();
    if (!port) {
      console.warn(`[session:${options.name}] hook injection skipped: HTTP listener port unavailable - hooks were not injected`);
      return NO_HOOK_INJECTION;
    }
    const injection = hookProfile.injection;
    if (injection?.kind === "argv-config") return injectRelayHooks(port, injection);
    if (injection?.kind === "home-hooks-file") return injectHomeRelayHooks(port, injection);
    if (injection?.kind === "generated-home") return injectGeneratedHomeHooks(port, injection);
    try {
      const buildSettingsArgs = options.adapter.settingsArgs;
      if (typeof buildSettingsArgs !== "function") {
        throw new TypeError(`agent ${options.agentId} carries no settings-file argv`);
      }
      const nextSettingsHandle = writeSessionSettings({
        port,
        glimmervoidId: options.id,
        baseDir: options.hooksBaseDir,
        permissions: options.settingsPermissions,
        detectScheduledWakeups: options.detectScheduledWakeups,
        observeToolCalls: options.observeToolCalls,
        enableProjectMcp: options.enableProjectMcp,
        hookTools: options.hookTools,
        planLimits: options.planLimits,
        planReview: options.planReview,
        holdsQuestionsForParent: options.holdsQuestionsForParent,
        userHooks: [
          ...(typeof options.getUserHooks === "function" ? options.getUserHooks() : []),
          ...glimmervoidSuppliedHooks(),
        ],
      });
      settingsHandle = nextSettingsHandle;
      token = nextSettingsHandle.token;
      options.hookRouter.register(options.id, {
        token,
        onSignal: options.ingestSignal,
        onEvent: options.observeHook,
        hooks: hookProfileOf(options.adapter),
        enrichPayload: payloadEnricherFor(hookProfileOf(options.adapter), options.agentEnv),
      });
      const isSaneYoloActive = saneYoloTool() !== undefined;
      return { args: buildSettingsArgs(nextSettingsHandle.settingsPath), env: hookToolEnv(isSaneYoloActive), isSaneYoloActive };
    } catch (error) {
      console.warn(`[session:${options.name}] hook injection failed: ${errorMessage(error)} - falling back to OSC title only`);
      cleanup();
      return NO_HOOK_INJECTION;
    }
  }

  return {
    prepare,
    inject,
    cleanup,
    token: () => token,
    listenerPort: resolveListenerPort,
    hasInjection: () => token !== null,
    hasSettings: () => settingsHandle !== null,
  };
}

export { createSessionHookLifecycle };
export type { HookRouterPort };

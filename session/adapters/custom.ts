import type { AgentEnvProfile } from "../core/spawn-env.ts";
import { classifyAgentTitle, isSpinnerChar } from "../core/title-classifier-core.ts";
import type {
  AgentAdapter,
  AgentArgsOptions,
  AgentCapabilities,
  AgentTitleProfile,
} from "./index.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";
import type { CustomAgentDeclaration } from "../../shared/contracts/index.ts";

const envProfile: AgentEnvProfile = { scrub: [], set: {} };

const TITLE_ONLY_CAPABILITIES: AgentCapabilities = Object.freeze({
  hooks: false,
  awaitingInput: false,
  backgroundAgents: false,
  resume: false,
  planLimits: false,
    saneYolo: false,
  compactQuiet: false,
  skipPermissionsFlag: false,
  headless: false,
});

interface BuiltInLaunch {
  initialPromptArgs?(initialPrompt: string): string[];
}

function createCustomAdapter(declaration: CustomAgentDeclaration, { initialPromptArgs }: BuiltInLaunch = {}): AgentAdapter {
  const declaredArgs = Object.freeze([...declaration.args]);
  const busyTitle = declaration.busyTitle?.trim() || null;
  const idleTitle = declaration.idleTitle?.trim() || null;

  function classifyTitle(title: string, { cwdBasename = null }: { cwdBasename?: string | null } = {}): string {
    return classifyAgentTitle(title, { cwdBasename }, { isSpinnerChar, busyTitle, idleTitle });
  }

  const titleProfile: AgentTitleProfile = {
    classifyTitle,
    taskTitle: { readsTranscriptTitle: false, genericTitles: [declaration.id], agentSuffix: ` - ${declaration.id}` },
  };

  const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(declaration.command, envProfile);

  function buildArgs({ initialPrompt = null }: AgentArgsOptions = {}): string[] {
    if (initialPrompt == null) return [...declaredArgs];
    if (initialPromptArgs) return initialPromptArgs(initialPrompt);
    return [...declaredArgs, initialPrompt];
  }

  return {
    id: declaration.id,
    label: declaration.label,
    usageVendor: declaration.id,
    commandName: declaration.command,
    envProfile,
    titleProfile,
    hooks: null,
    capabilities: TITLE_ONLY_CAPABILITIES,
    resolveCommand,
    buildSpawnCommand,
    buildEnv,
    buildArgs,
  };
}

export { createCustomAdapter };

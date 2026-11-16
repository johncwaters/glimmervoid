import { SIGN_URL_ENV } from "../../shared/contracts/session.ts";

const GIT_CONFIG_PARAMETERS_ENV = "GIT_CONFIG_PARAMETERS";

type GitConfigEntry = readonly [key: string, value: string];
type GitConfigForm = "parameters" | "numbered";

interface SessionGitSetting {
  env: Record<string, string>;
  configEntries: GitConfigEntry[];
}

const NO_GIT_SETTING: SessionGitSetting = Object.freeze({ env: {}, configEntries: [] });

function singleQuoteForGit(text: string): string {
  return `'${text.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;
}

function commitSigningSetting({ port, sessionId, token, signingProgram }: {
  port: number | null;
  sessionId: string;
  token: string | null;
  signingProgram: string | null;
}): SessionGitSetting {
  if (!port || !token || !signingProgram) return NO_GIT_SETTING;
  return {
    env: { [SIGN_URL_ENV]: `http://127.0.0.1:${port}/sign/${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}` },
    configEntries: [["gpg.ssh.program", signingProgram]],
  };
}

function parametersEnv(configEntries: readonly GitConfigEntry[], inheritedConfigParameters: string | undefined): Record<string, string> {
  const ownParameters = configEntries.map(([key, value]) => singleQuoteForGit(`${key}=${value}`));
  return { [GIT_CONFIG_PARAMETERS_ENV]: [...(inheritedConfigParameters ? [inheritedConfigParameters] : []), ...ownParameters].join(" ") };
}

function numberedEnv(configEntries: readonly GitConfigEntry[], inheritedConfigCount: string | undefined): Record<string, string> {
  const firstIndex = Number.parseInt(inheritedConfigCount ?? "0", 10) || 0;
  const numbered: Record<string, string> = { GIT_CONFIG_COUNT: String(firstIndex + configEntries.length) };
  for (const [offset, [key, value]] of configEntries.entries()) {
    numbered[`GIT_CONFIG_KEY_${firstIndex + offset}`] = key;
    numbered[`GIT_CONFIG_VALUE_${firstIndex + offset}`] = value;
  }
  return numbered;
}

function gitConfigEnv({ configEntries, form, inheritedConfigParameters, inheritedConfigCount }: {
  configEntries: readonly GitConfigEntry[];
  form: GitConfigForm;
  inheritedConfigParameters: string | undefined;
  inheritedConfigCount: string | undefined;
}): Record<string, string> {
  if (configEntries.length === 0) return {};
  return form === "numbered" ? numberedEnv(configEntries, inheritedConfigCount) : parametersEnv(configEntries, inheritedConfigParameters);
}

export { NO_GIT_SETTING, commitSigningSetting, gitConfigEnv };
export type { GitConfigForm, SessionGitSetting };

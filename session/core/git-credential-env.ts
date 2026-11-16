import { GIT_CREDENTIAL_PATH_PREFIX, GIT_CREDENTIAL_URL_ENV } from "../../shared/contracts/session.ts";
import { NO_GIT_SETTING } from "./commit-signing-env.ts";
import type { GitConfigForm, SessionGitSetting } from "./commit-signing-env.ts";

const GITHUB_CREDENTIAL_SCOPE = "https://github.com";
const HELPER_KEY = `credential.${GITHUB_CREDENTIAL_SCOPE}.helper`;

function posixSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function gitCredentialSetting({ port, sessionId, token, helperProgram, form }: {
  port: number | null;
  sessionId: string;
  token: string | null;
  helperProgram: string | null;
  form: GitConfigForm;
}): SessionGitSetting {
  if (!port || !token || !helperProgram) return NO_GIT_SETTING;
  return {
    env: { [GIT_CREDENTIAL_URL_ENV]: `http://127.0.0.1:${port}${GIT_CREDENTIAL_PATH_PREFIX}${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}` },
    configEntries: [...(form === "numbered" ? [[HELPER_KEY, ""] as const] : []), [HELPER_KEY, `!${posixSingleQuote(helperProgram)}`]],
  };
}

export { GITHUB_CREDENTIAL_SCOPE, gitCredentialSetting };

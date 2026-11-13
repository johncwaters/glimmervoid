import { GIT_CREDENTIAL_PATH_PREFIX, GIT_CREDENTIAL_URL_ENV } from "../../shared/contracts/session.ts";
import { GIT_CONFIG_PARAMETERS_ENV, singleQuoteForGit } from "./commit-signing-env.ts";

const GITHUB_CREDENTIAL_SCOPE = "https://github.com";

function posixSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function gitCredentialEnv({ port, sessionId, token, helperProgram, inheritedConfigParameters }: {
  port: number | null;
  sessionId: string;
  token: string | null;
  helperProgram: string | null;
  inheritedConfigParameters: string | undefined;
}): Record<string, string> {
  if (!port || !token || !helperProgram) return {};
  const helperParameter = singleQuoteForGit(`credential.${GITHUB_CREDENTIAL_SCOPE}.helper=!${posixSingleQuote(helperProgram)}`);
  return {
    [GIT_CREDENTIAL_URL_ENV]: `http://127.0.0.1:${port}${GIT_CREDENTIAL_PATH_PREFIX}${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}`,
    [GIT_CONFIG_PARAMETERS_ENV]: inheritedConfigParameters ? `${inheritedConfigParameters} ${helperParameter}` : helperParameter,
  };
}

export { GITHUB_CREDENTIAL_SCOPE, gitCredentialEnv };

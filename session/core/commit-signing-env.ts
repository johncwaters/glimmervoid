import { SIGN_URL_ENV } from "../../shared/contracts/session.ts";

const GIT_CONFIG_PARAMETERS_ENV = "GIT_CONFIG_PARAMETERS";

function singleQuoteForGit(text: string): string {
  return `'${text.replace(/'/g, "'\\''").replace(/!/g, "'\\!'")}'`;
}

function commitSigningEnv({ port, sessionId, token, signingProgram, inheritedConfigParameters }: {
  port: number | null;
  sessionId: string;
  token: string | null;
  signingProgram: string | null;
  inheritedConfigParameters: string | undefined;
}): Record<string, string> {
  if (!port || !token || !signingProgram) return {};
  const programParameter = singleQuoteForGit(`gpg.ssh.program=${signingProgram}`);
  return {
    [SIGN_URL_ENV]: `http://127.0.0.1:${port}/sign/${encodeURIComponent(sessionId)}?t=${encodeURIComponent(token)}`,
    [GIT_CONFIG_PARAMETERS_ENV]: inheritedConfigParameters ? `${inheritedConfigParameters} ${programParameter}` : programParameter,
  };
}

export { commitSigningEnv };

const CREDENTIAL_SEPARATOR = '.';
const BEARER_PREFIX = /^Bearer\s+/i;

interface PresentedCredential {
  sessionId: string;
  secret: string;
}

function mcpCredentialFor(sessionId: string, secret: string): string {
  return `${sessionId}${CREDENTIAL_SEPARATOR}${secret}`;
}

function parsePresentedCredential(authorizationHeader: string | undefined): PresentedCredential | null {
  if (!authorizationHeader || !BEARER_PREFIX.test(authorizationHeader)) return null;
  const credential = authorizationHeader.replace(BEARER_PREFIX, '').trim();
  const separatorIndex = credential.indexOf(CREDENTIAL_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === credential.length - 1) return null;
  return { sessionId: credential.slice(0, separatorIndex), secret: credential.slice(separatorIndex + 1) };
}

export { mcpCredentialFor, parsePresentedCredential };
export type { PresentedCredential };

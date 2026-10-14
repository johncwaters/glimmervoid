const WORKFLOW_PATH_PREFIX = '.github/workflows/';
const WORKFLOW_ANCESTOR_ENTRIES = new Set(['.github', '.github/workflows']);
const GITHUB_DIRECTORY_ENTRY = '.github';
const CREDENTIAL_LIKE_FILE_NAMES = [/^\.env/i, /\.pem$/i, /^id_rsa/i, /^\.npmrc$/i, /^\.netrc$/i, /^credentials/i, /\.key$/i];

export function nulSeparatedPaths(output: string): string[] {
  return output.split('\0').filter((filePath) => filePath.length > 0);
}

function forwardSlashed(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function isWorkflowPath(filePath: string): boolean {
  const normalizedPath = forwardSlashed(filePath);
  return WORKFLOW_ANCESTOR_ENTRIES.has(normalizedPath) || normalizedPath.startsWith(WORKFLOW_PATH_PREFIX);
}

export function isGithubDirectoryPath(filePath: string): boolean {
  const normalizedPath = forwardSlashed(filePath);
  return normalizedPath === GITHUB_DIRECTORY_ENTRY || normalizedPath.startsWith(`${GITHUB_DIRECTORY_ENTRY}/`);
}

export function isCredentialLikePath(filePath: string): boolean {
  const fileName = forwardSlashed(filePath).split('/').at(-1) ?? '';
  return CREDENTIAL_LIKE_FILE_NAMES.some((pattern) => pattern.test(fileName));
}

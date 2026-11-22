import { isCredentialLikePath, isGithubDirectoryPath } from '../../../shared/git-text.ts';

const WORKFLOW_PATH_PREFIX = '.github/workflows/';
const WORKFLOW_ANCESTOR_ENTRIES = new Set(['.github', '.github/workflows']);

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

export { isCredentialLikePath, isGithubDirectoryPath };

const COHERENCE_RECORD_STORE_DIRECTORIES = ['.coherence/journal', '.coherence/runs', '.coherence/work'];
const COHERENCE_RECORD_EXTENSIONS = ['jsonl', 'jsonseq'];
const COHERENCE_RECORD_FILE_PATTERN = /^\.coherence\/(?:journal|runs|work)\/[^/]+\.(?:jsonl|jsonseq)$/;
const COHERENCE_RECORD_GLOBS = COHERENCE_RECORD_STORE_DIRECTORIES.flatMap((directory) => COHERENCE_RECORD_EXTENSIONS.map((extension) => `${directory}/*.${extension}`));
export const COHERENCE_RECORD_PATHSPECS = COHERENCE_RECORD_GLOBS.map((recordGlob) => `:(glob)${recordGlob}`);
export const COHERENCE_BOOKKEEPING_PATHSPEC = ['--', '.', ...COHERENCE_RECORD_GLOBS.map((recordGlob) => `:(exclude,glob)${recordGlob}`)];

export function isCoherenceJournalPath(journalPath: string): boolean {
  return COHERENCE_RECORD_FILE_PATTERN.test(journalPath);
}

import { readStdin } from './relay-stdin.ts';
import type { StdinLike } from './relay-stdin.ts';
import { postPayload } from './loopback-post.ts';
import { resumeNoteOf, sessionStartContextOutput } from './core/refocus-core.ts';
import { REWAKE_RELAY_MODE } from '../shared/contracts/refocus.ts';

const REWAKE_EXIT_CODE = 2;

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  stdout: { write(text: string): unknown } = process.stdout,
  stderr: { write(text: string): unknown } = process.stderr,
): Promise<number> {
  const [postUrl, mode] = argv;
  const body = await readStdin(stdin);
  if (!postUrl) return 0;
  const responseBody = await postPayload(postUrl, body);
  if (mode === REWAKE_RELAY_MODE) return rewakeWith(resumeNoteOf(responseBody), stderr);
  const contextOutput = sessionStartContextOutput(responseBody);
  if (contextOutput !== null) stdout.write(contextOutput);
  return 0;
}

function rewakeWith(resumeNote: string | null, stderr: { write(text: string): unknown }): number {
  if (resumeNote === null) return 0;
  stderr.write(resumeNote);
  return REWAKE_EXIT_CODE;
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}

export { main };

import { postToAgentIngress } from './agent-api-cli.ts';
import { parseJsonOrNull } from './core/json-core.ts';
import { sessionEndpointOf } from './ssh-sign-cli.ts';
import { GIT_CREDENTIAL_PATH_PREFIX, GIT_CREDENTIAL_URL_ENV, GitCredentialReply } from '../shared/contracts/session.ts';

const ANSWER_TIMEOUT_MS = 30_000;

function credentialAttributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') return attributes;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex > 0) attributes.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
  }
  return attributes;
}

async function readAllText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function runGitCredentialCli(args: readonly string[], { env = process.env, stdin = process.stdin, stdout = process.stdout }: {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadableStream;
  stdout?: Pick<NodeJS.WritableStream, 'write'>;
} = {}): Promise<number> {
  if (args[0] !== 'get') return 0;
  const target = sessionEndpointOf(env[GIT_CREDENTIAL_URL_ENV], GIT_CREDENTIAL_PATH_PREFIX);
  if (target === null) return 0;
  const attributes = credentialAttributesOf(await readAllText(stdin));
  const reply = await postToAgentIngress({
    endpoint: target.endpoint,
    token: target.token,
    body: { protocol: attributes.get('protocol') ?? '', host: attributes.get('host') ?? '' },
    deadline: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
  }).then((answer) => GitCredentialReply.safeParse(parseJsonOrNull(answer.text)), () => null);
  if (!reply?.success || !reply.data.found) return 0;
  stdout.write(`username=${reply.data.username}\npassword=${reply.data.password}\npassword_expiry_utc=${reply.data.passwordExpiryUtc}\n`);
  return 0;
}

export { runGitCredentialCli };

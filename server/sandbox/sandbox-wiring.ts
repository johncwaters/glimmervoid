import fsp from 'node:fs/promises';
import type { RequestListener, Server } from 'node:http';
import { findNodeLauncherPath, resolvePackageBin, seatbeltLauncherPath } from '../runtime-paths.ts';
import { firstCommandOnPath } from '../stable-node-path.ts';
import type { PrepareSandbox } from '../../session/sessions.ts';
import { sessionSandboxFor } from './sandbox-launch.ts';
import { createCredentialProxies } from './credential-proxy.ts';
import { createLoginRefresher } from './login-refresh.ts';
import type { ModelLogin } from './credential-proxy.ts';
import { modelTokenFrom } from './core/credential-decider-core.ts';
import type { SandboxLauncher, SandboxTools } from './sandbox-launch.ts';

interface SessionSandboxWiring {
  platform: NodeJS.Platform;
  glimmervoidHome: string;
  configPath: string;
  agentIngressServer: Server;
  listenIngressSocket: (options: { socketPath: string; ingressApp: RequestListener }) => Promise<{ close(): Promise<void> }>;
  getIngressPort: () => number | null;
  getExtraAllowedHosts: () => readonly string[];
  isWeakerNetworkIsolationOn: () => boolean;
  getAgentAccountFolders: () => readonly string[];
  githubUserToken: () => Promise<string | null>;
  logger: Pick<Console, 'warn'>;
}

interface ProxyCertificateAuthority {
  certificatePem: string;
  privateKeyPem: string;
}

async function generateProxyCertificateAuthority(): Promise<ProxyCertificateAuthority> {
  const { generateCa } = await import('@anthropic-ai/sandbox-runtime');
  const generated = generateCa({ cn: 'Glimmervoid session egress' });
  return { certificatePem: generated.certPem, privateKeyPem: generated.keyPem };
}

async function readModelToken(login: ModelLogin): Promise<string | null> {
  if (login.loginFile === null) return null;
  const loginFileText = await fsp.readFile(login.loginFile, 'utf8').catch(() => null);
  return loginFileText === null ? null : modelTokenFrom(login.agent, loginFileText);
}

const SANDBOXED_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(['linux', 'darwin']);

async function findSandboxLauncher(platform: NodeJS.Platform): Promise<SandboxLauncher | { refusal: string }> {
  if (platform === 'darwin') return { kind: 'seatbelt', seatbeltLauncherPath };
  const socatPath = await firstCommandOnPath('socat');
  if (socatPath === null) return { refusal: 'socat is not on PATH' };
  return { kind: 'bubblewrap', socatPath };
}

async function findSandboxTools(platform: NodeJS.Platform): Promise<SandboxTools | { refusal: string }> {
  const srtCliPath = resolvePackageBin('@anthropic-ai/sandbox-runtime', 'srt');
  if (srtCliPath === null) return { refusal: 'the sandbox runtime (srt) is not installed' };
  const launcher = await findSandboxLauncher(platform);
  if ('refusal' in launcher) return launcher;
  const nodePath = await findNodeLauncherPath();
  if (nodePath === null) return { refusal: 'node is not on PATH' };
  return { nodePath, srtCliPath, launcher };
}

const RUNTIME_COMMANDS_BY_PLATFORM: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = Object.freeze({ linux: ['bwrap', 'rg'], darwin: ['sandbox-exec'] });

async function missingRuntimeCommand(platform: NodeJS.Platform): Promise<string | null> {
  const commandPaths = await Promise.all((RUNTIME_COMMANDS_BY_PLATFORM[platform] ?? []).map(async (command) => ({ command, commandPath: await firstCommandOnPath(command) })));
  const missing = commandPaths.find((found) => found.commandPath === null);
  return missing ? `${missing.command} is not on PATH` : null;
}

function refusingSandbox(reason: string): PrepareSandbox {
  return async () => ({ ok: false, reason });
}

interface SessionSandbox {
  sandboxFor: (sessionTempFolder: string | null, hiddenFolders: readonly string[]) => PrepareSandbox;
  refusal: () => Promise<string | null>;
  recheckLogins: () => void;
}

function createSessionSandbox(wiring: SessionSandboxWiring): SessionSandbox | null {
  if (!SANDBOXED_PLATFORMS.includes(wiring.platform)) return null;
  let foundTools: SandboxTools | null = null;
  let certificateAuthority: Promise<ProxyCertificateAuthority> | null = null;
  const proxyCertificateAuthority = () => {
    certificateAuthority ??= generateProxyCertificateAuthority();
    return certificateAuthority;
  };
  const resolveTools = async () => {
    if (foundTools !== null) return foundTools;
    const tools = await findSandboxTools(wiring.platform);
    if (!('refusal' in tools)) foundTools = tools;
    return tools;
  };
  const loginRefresher = createLoginRefresher(wiring.logger);
  const credentialProxies = createCredentialProxies({
    resolveTools,
    certificateAuthorityPem: async () => {
      const authority = await proxyCertificateAuthority();
      return `${authority.privateKeyPem.trim()}\n${authority.certificatePem.trim()}\n`;
    },
    readGithubToken: wiring.githubUserToken,
    readModelToken,
    watchLogin: loginRefresher.watch,
    logger: wiring.logger,
  });
  const dependencies = {
    glimmervoidHome: wiring.glimmervoidHome,
    configPath: wiring.configPath,
    ingressRequestListener: ((request, response) => { wiring.agentIngressServer.emit('request', request, response); }) satisfies RequestListener,
    listenIngressSocket: wiring.listenIngressSocket,
    getIngressPort: wiring.getIngressPort,
    getExtraAllowedHosts: wiring.getExtraAllowedHosts,
    isWeakerNetworkIsolationOn: wiring.isWeakerNetworkIsolationOn,
    getAgentAccountFolders: wiring.getAgentAccountFolders,
    resolveTools,
    credentialProxies,
    proxyCertificatePem: async () => (await proxyCertificateAuthority()).certificatePem,
  };
  return {
    sandboxFor: (sessionTempFolder, hiddenFolders) => sessionTempFolder === null
      ? refusingSandbox('the session has no temp folder to hold its sandbox')
      : sessionSandboxFor(dependencies, sessionTempFolder, hiddenFolders),
    refusal: async () => {
      const tools = await resolveTools();
      if ('refusal' in tools) return tools.refusal;
      return missingRuntimeCommand(wiring.platform);
    },
    recheckLogins: loginRefresher.recheckAll,
  };
}

export { createSessionSandbox, refusingSandbox };

import fsp from 'node:fs/promises';
import type { RequestListener, Server } from 'node:http';
import { findNodeLauncherPath, resolvePackageBin } from '../runtime-paths.ts';
import { firstCommandOnPath } from '../stable-node-path.ts';
import type { PrepareSandbox } from '../../session/sessions.ts';
import { sessionSandboxFor } from './sandbox-launch.ts';
import { createCredentialProxies } from './credential-proxy.ts';
import type { ModelLogin } from './credential-proxy.ts';
import { modelTokenFrom } from './core/credential-decider-core.ts';
import type { SandboxTools } from './sandbox-launch.ts';

interface SessionSandboxWiring {
  isOn: boolean;
  platform: NodeJS.Platform;
  glimmervoidHome: string;
  configPath: string;
  agentIngressServer: Server;
  getIngressPort: () => number | null;
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

async function findSandboxTools(): Promise<SandboxTools | { refusal: string }> {
  const srtCliPath = resolvePackageBin('@anthropic-ai/sandbox-runtime', 'srt');
  if (srtCliPath === null) return { refusal: 'the sandbox runtime (srt) is not installed' };
  const socatPath = await firstCommandOnPath('socat');
  if (socatPath === null) return { refusal: 'socat is not on PATH' };
  const nodePath = await findNodeLauncherPath();
  if (nodePath === null) return { refusal: 'node is not on PATH' };
  return { nodePath, srtCliPath, socatPath };
}

function refusingSandbox(reason: string): PrepareSandbox {
  return async () => ({ ok: false, reason });
}

function createSessionSandbox(wiring: SessionSandboxWiring): ((sessionTempFolder: string | null) => PrepareSandbox) | null {
  if (!wiring.isOn) return null;
  if (wiring.platform !== 'linux') throw new Error(`sessionSandbox is on, but sandboxed sessions run only on Linux (this machine is ${wiring.platform})`);
  let foundTools: SandboxTools | null = null;
  let certificateAuthority: Promise<ProxyCertificateAuthority> | null = null;
  const proxyCertificateAuthority = () => {
    certificateAuthority ??= generateProxyCertificateAuthority();
    return certificateAuthority;
  };
  const resolveTools = async () => {
    if (foundTools !== null) return foundTools;
    const tools = await findSandboxTools();
    if (!('refusal' in tools)) foundTools = tools;
    return tools;
  };
  const credentialProxies = createCredentialProxies({
    resolveTools,
    certificateAuthorityPem: async () => {
      const authority = await proxyCertificateAuthority();
      return `${authority.privateKeyPem.trim()}\n${authority.certificatePem.trim()}\n`;
    },
    readGithubToken: wiring.githubUserToken,
    readModelToken,
    logger: wiring.logger,
  });
  const dependencies = {
    glimmervoidHome: wiring.glimmervoidHome,
    configPath: wiring.configPath,
    ingressRequestListener: ((request, response) => { wiring.agentIngressServer.emit('request', request, response); }) satisfies RequestListener,
    getIngressPort: wiring.getIngressPort,
    getExtraAllowedHosts: () => [],
    getAgentAccountFolders: wiring.getAgentAccountFolders,
    resolveTools,
    credentialProxies,
    proxyCertificatePem: async () => (await proxyCertificateAuthority()).certificatePem,
  };
  return (sessionTempFolder) => sessionTempFolder === null
    ? refusingSandbox('the session has no temp folder to hold its sandbox')
    : sessionSandboxFor(dependencies, sessionTempFolder);
}

export { createSessionSandbox };

import type { RequestListener, Server } from 'node:http';
import { findNodeLauncherPath, resolvePackageBin } from '../runtime-paths.ts';
import { firstCommandOnPath } from '../stable-node-path.ts';
import type { PrepareSandbox } from '../../session/sessions.ts';
import { sessionSandboxFor } from './sandbox-launch.ts';
import type { SandboxTools } from './sandbox-launch.ts';

interface SessionSandboxWiring {
  isOn: boolean;
  platform: NodeJS.Platform;
  glimmervoidHome: string;
  configPath: string;
  agentIngressServer: Server;
  getIngressPort: () => number | null;
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
  const dependencies = {
    glimmervoidHome: wiring.glimmervoidHome,
    configPath: wiring.configPath,
    ingressRequestListener: ((request, response) => { wiring.agentIngressServer.emit('request', request, response); }) satisfies RequestListener,
    getIngressPort: wiring.getIngressPort,
    getExtraAllowedHosts: () => [],
    resolveTools: async () => {
      if (foundTools !== null) return foundTools;
      const tools = await findSandboxTools();
      if (!('refusal' in tools)) foundTools = tools;
      return tools;
    },
  };
  return (sessionTempFolder) => sessionTempFolder === null
    ? refusingSandbox('the session has no temp folder to hold its sandbox')
    : sessionSandboxFor(dependencies, sessionTempFolder);
}

export { createSessionSandbox };

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import { listenAgentIngressSocket } from '../backend/backend-http.ts';
import { runGit } from '../git/git-exec.ts';
import { writeTextAtomic } from '../json-file.ts';
import { glimmervoidSecretPaths } from '../secrets/core/secret-files-core.ts';
import { errorMessage } from '../../shared/text.ts';
import type { PrepareSandbox, SandboxLaunchFacts } from '../../session/sessions.ts';
import type { SpawnEnv } from '../../session/core/spawn-env.ts';
import type { GitRepositoryLayout } from './core/sandbox-policy-core.ts';
import { SHORT_SOCKET_FOLDER_PREFIX, buildSrtSettings, ingressSocketPathIn, sandboxedCommand, srtSettingsPathIn } from './core/sandbox-policy-core.ts';

interface SandboxTools {
  nodePath: string;
  srtCliPath: string;
  socatPath: string;
}

interface SessionSandboxDependencies {
  glimmervoidHome: string;
  configPath: string;
  ingressRequestListener: RequestListener;
  getIngressPort: () => number | null;
  resolveTools: () => Promise<SandboxTools | { refusal: string }>;
  getExtraAllowedHosts: () => readonly string[];
}

async function dotGitFileIn(repositoryRoot: string): Promise<string | null> {
  const dotGitPath = path.join(repositoryRoot, '.git');
  const dotGit = await fsp.lstat(dotGitPath).catch(() => null);
  return dotGit !== null && !dotGit.isDirectory() ? dotGitPath : null;
}

async function gitRepositoryAt(folder: string): Promise<GitRepositoryLayout | null> {
  const answer = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir', '--show-toplevel'], { cwd: folder });
  if (!answer.ok) return null;
  const [commonDir, gitDir, repositoryRoot] = answer.out.split('\n');
  if (!commonDir || !gitDir || !repositoryRoot) return null;
  return { commonDir, gitDir, dotGitFile: await dotGitFileIn(repositoryRoot) };
}

async function gitRepositoriesUnder(worktree: string): Promise<GitRepositoryLayout[]> {
  const ownRepository = await gitRepositoryAt(worktree);
  if (ownRepository !== null) return [ownRepository];
  const entries = await fsp.readdir(worktree, { withFileTypes: true }).catch(() => []);
  const childRepositories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => gitRepositoryAt(path.join(worktree, entry.name))));
  return childRepositories.filter((repository) => repository !== null);
}

function readableFilesIn(env: SpawnEnv): string[] {
  const systemGitConfig = env.GIT_CONFIG_SYSTEM;
  return systemGitConfig ? [systemGitConfig] : [];
}

function sessionSandboxFor(dependencies: SessionSandboxDependencies, sessionTempFolder: string): PrepareSandbox {
  return async (facts: SandboxLaunchFacts) => {
    const ingressPort = dependencies.getIngressPort();
    if (ingressPort === null) return { ok: false, reason: 'the agent endpoint is not listening yet' };
    const tools = await dependencies.resolveTools();
    if ('refusal' in tools) return { ok: false, reason: tools.refusal };
    const settingsPath = srtSettingsPathIn(sessionTempFolder);
    const settings = buildSrtSettings({
      homeDir: os.homedir(),
      glimmervoidHome: dependencies.glimmervoidHome,
      configFolder: path.dirname(dependencies.configPath),
      secretPaths: glimmervoidSecretPaths({ glimmervoidHome: dependencies.glimmervoidHome, configPath: dependencies.configPath }),
      userId: os.userInfo().uid,
      worktree: facts.cwd,
      gitRepositories: await gitRepositoriesUnder(facts.cwd),
      sessionTempFolder,
      readableFiles: readableFilesIn(facts.env),
      extraAllowedHosts: dependencies.getExtraAllowedHosts(),
    });
    await writeTextAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const socketFolder = await fsp.mkdtemp(SHORT_SOCKET_FOLDER_PREFIX);
    const ingressSocketPath = ingressSocketPathIn(socketFolder);
    const removeSocketFolder = () => fsp.rm(socketFolder, { recursive: true, force: true });
    const ingressSocket = await listenAgentIngressSocket({ socketPath: ingressSocketPath, ingressApp: dependencies.ingressRequestListener })
      .catch((error: unknown) => ({ refusal: `the session bridge could not listen: ${errorMessage(error)}` }));
    if ('refusal' in ingressSocket) {
      await removeSocketFolder();
      return { ok: false, reason: ingressSocket.refusal };
    }
    const command = sandboxedCommand({ ...tools, settingsPath, ingressPort, ingressSocketPath, agentTempFolder: sessionTempFolder, file: facts.file, args: facts.args });
    return {
      ok: true,
      launch: {
        ...command,
        env: { ...facts.env, TMPDIR: socketFolder },
        dispose: async () => {
          await ingressSocket.close();
          await removeSocketFolder();
        },
      },
    };
  };
}

export { sessionSandboxFor };
export type { SandboxTools };

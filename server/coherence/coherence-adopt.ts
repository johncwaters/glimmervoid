import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoherenceAdoptError } from '../../shared/contracts/coherence.ts';
import type { ProjectCoherenceAdoptResult, ProjectCoherenceStatus } from '../../shared/contracts/coherence.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { COHERENCE_CONFIG_FILENAME } from './core/coherence-config-core.ts';
import {
  COHERENCE_ADOPT_CONFIG_TEXT, COHERENCE_ADOPT_CONTROL_FILES, COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER, COHERENCE_ADOPT_HOSTS, COHERENCE_ADOPT_NO_SYMLINK_PATHS, COHERENCE_ADOPT_NODE_MODULES_PATHSPECS,
  COHERENCE_ADOPT_NPM_FILE_MAX_BYTES, COHERENCE_ADOPT_NPM_FILES, COHERENCE_ADOPT_TIMEOUT_MS, COHERENCE_PACKAGE_NAME,
  coherenceAdoptCommitMessage, coherenceAdoptStepFailure, coherenceHooksInstallArgs, coherenceNpmLockfileArgs, coherencePushArgs, gitignoreTextWithNodeModules,
  isExactCoherenceVersion, judgeCoherenceAdoptPaths, judgeCoherenceAdoptRequest, judgeCoherenceAdoptTrackedPaths, packageTextWithCoherencePin, pathsFromPorcelainStatus,
} from './core/coherence-adopt-core.ts';
import type { CoherenceAdoptStep } from './core/coherence-adopt-core.ts';
import { isCompletedCommandFailure } from '../core/command-failure-core.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import { firstLine } from '../core/text-core.ts';
import { buildFactoryCheckEnv } from '../factory/core/factory-core.ts';
import { runCommand } from '../git/git-exec.ts';
import { factoryGitEnvironment, runHardenedGit } from '../git/git-workspace.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { integrationTipReader } from './coherence-readings.ts';
import { createCoherenceRuntime } from './coherence-runtime.ts';
import { coherenceEnv, wasKilledByTimeout } from './coherence-sandboxed-run.ts';

interface AdoptProject {
  id: string;
  path: string;
}

type AdoptGitWorkspace = Pick<GitWorkspaceInstance,
  'detectDefaultBranch' | 'listIntegrationTips' | 'originUrl' | 'fetchOrigin' | 'stageDetachedWorktree' | 'removeWorktreeByPath'>;

interface CoherenceAdoptOptions {
  listProjects: () => AdoptProject[];
  readConfig: () => { integrationBranch?: unknown };
  gitWorkspace: AdoptGitWorkspace;
  broadcastControl: (message: ServerMessageOf<'project-coherence-status'>) => void;
  cliPath?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn'>;
}

type AdoptFailure = { ok: false; error: CoherenceAdoptError; detail: string; ignoredPaths?: string[] };
type ShippedCoherence = { cliPath: string; version: string };
type NpmFileTexts = Record<string, string | null>;
type AdoptOutcome<Value> = { ok: true; value: Value } | AdoptFailure;

const GIT_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const NPM_PASSTHROUGH_ENV = /^(npm_config_.+|https?_proxy|no_proxy)$/i;

function failure(error: CoherenceAdoptError, detail: string): AdoptFailure {
  return { ok: false, error, detail };
}

function succeeded<Value>(value: Value): AdoptOutcome<Value> {
  return { ok: true, value };
}

function stepFailure(step: CoherenceAdoptStep, error: unknown): AdoptFailure {
  return failure(coherenceAdoptStepFailure(step, { isTimedOut: wasKilledByTimeout(error) }), `${step}: ${firstLine(errorMessage(error))}`);
}

async function isGitRepository(projectPath: string): Promise<boolean> {
  try {
    await runHardenedGit(['rev-parse', '--git-dir'], { cwd: projectPath, timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function hasPathAtCommit(cwd: string, sha: string, relativePath: string): Promise<boolean> {
  try {
    await runHardenedGit(['cat-file', '-e', `${sha}:${relativePath}`], { cwd, timeout: GIT_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (isCompletedCommandFailure(error)) return false;
    throw error;
  }
}

async function isNodeModulesIgnored(checkout: string): Promise<boolean> {
  try {
    await runHardenedGit(['check-ignore', '-q', '--', COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER.relativePath.join('/')], { cwd: checkout, timeout: GIT_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (isCompletedCommandFailure(error) && error.code === 1) return false;
    throw error;
  }
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  return readFile(filePath, 'utf8').catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
}

async function findSymlinkedTarget(checkout: string): Promise<string | null> {
  for (const relativePath of COHERENCE_ADOPT_NO_SYMLINK_PATHS) {
    const entry = await lstat(path.join(checkout, relativePath)).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (entry?.isSymbolicLink()) return relativePath;
  }
  return null;
}

async function trackedNodeModulesPaths(checkout: string): Promise<string[]> {
  const { stdout } = await runHardenedGit(['ls-files', '-z', '--', ...COHERENCE_ADOPT_NODE_MODULES_PATHSPECS], { cwd: checkout, timeout: GIT_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES });
  return stdout.split('\0').filter((trackedPath) => trackedPath !== '');
}

async function ignoredControlPaths(checkout: string): Promise<string[]> {
  try {
    const { stdout } = await runHardenedGit(['check-ignore', '--', ...COHERENCE_ADOPT_CONTROL_FILES], { cwd: checkout, timeout: GIT_TIMEOUT_MS });
    return stdout.split('\n').filter((ignoredPath) => ignoredPath !== '');
  } catch (error) {
    if (isCompletedCommandFailure(error) && error.code === 1) return [];
    throw error;
  }
}

async function readNpmFiles(checkout: string): Promise<AdoptOutcome<NpmFileTexts>> {
  const textByName: NpmFileTexts = {};
  for (const fileName of COHERENCE_ADOPT_NPM_FILES) {
    const filePath = path.join(checkout, fileName);
    const entry = await lstat(filePath).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    textByName[fileName] = null;
    if (entry === null) continue;
    if (!entry.isFile()) return failure(CoherenceAdoptError.enum.failed, `${fileName} is not a regular file`);
    if (entry.size > COHERENCE_ADOPT_NPM_FILE_MAX_BYTES) return failure(CoherenceAdoptError.enum.failed, `${fileName} is larger than ${COHERENCE_ADOPT_NPM_FILE_MAX_BYTES} bytes`);
    textByName[fileName] = await readFile(filePath, 'utf8');
  }
  return succeeded(textByName);
}

async function readShippedCoherence(cliPath: string | null): Promise<ShippedCoherence | null> {
  if (!cliPath) return null;
  const manifest: unknown = JSON.parse(await readFile(path.resolve(cliPath, '..', '..', 'package.json'), 'utf8'));
  const name: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'name') : null;
  const version: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : null;
  return name === COHERENCE_PACKAGE_NAME && isExactCoherenceVersion(version) ? { cliPath, version } : null;
}

function createCoherenceAdopt({
  listProjects, readConfig, gitWorkspace, broadcastControl, cliPath = createCoherenceRuntime().cliPath, baseEnv = process.env, log = console,
}: CoherenceAdoptOptions) {
  const inFlightByProject = new Map<string, Promise<ProjectCoherenceAdoptResult>>();
  const readIntegrationTip = integrationTipReader(gitWorkspace, readConfig);

  function npmEnv(): Record<string, string> {
    const passedThrough = Object.entries(baseEnv).filter((entry): entry is [string, string] => entry[1] !== undefined && NPM_PASSTHROUGH_ENV.test(entry[0]));
    return { ...buildFactoryCheckEnv(baseEnv, process.platform), ...Object.fromEntries(passedThrough) };
  }

  async function resolveIntegrationBranch(projectPath: string): Promise<AdoptOutcome<string>> {
    const branch = configuredIntegrationBranch(readConfig()) ?? await gitWorkspace.detectDefaultBranch({ projectPath });
    if (!branch || branch.startsWith('-')) return failure(CoherenceAdoptError.enum.failed, 'no integration branch');
    try {
      await runHardenedGit(['check-ref-format', '--branch', branch], { cwd: projectPath, timeout: GIT_TIMEOUT_MS });
      return succeeded(branch);
    } catch (error) {
      return failure(CoherenceAdoptError.enum.failed, `integration branch ${branch} is not a branch name: ${firstLine(errorMessage(error))}`);
    }
  }

  async function fetchIntegrationTip(projectPath: string, branch: string): Promise<AdoptOutcome<string>> {
    const fetched = await gitWorkspace.fetchOrigin({ projectPath, branch });
    if (!fetched.ok) return failure(coherenceAdoptStepFailure('fetch', { isTimedOut: (fetched.err ?? '').startsWith('timed out') }), `fetch: ${firstLine(fetched.err ?? '')}`);
    try {
      const { stdout } = await runHardenedGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { cwd: projectPath, timeout: GIT_TIMEOUT_MS });
      return succeeded(stdout.trim());
    } catch (error) {
      return failure(CoherenceAdoptError.enum.failed, `origin has no ${branch}: ${firstLine(errorMessage(error))}`);
    }
  }

  async function runStep(step: CoherenceAdoptStep, file: string, args: string[], { cwd, timeoutMs, env }: {
    cwd: string; timeoutMs: number; env: Record<string, string>;
  }): Promise<AdoptFailure | null> {
    const ran = await runCommand(file, args, { cwd, timeoutMs, replaceEnv: env, maxBuffer: COMMAND_MAX_BUFFER_BYTES, preferStderr: true });
    if (ran.ok) return null;
    return failure(coherenceAdoptStepFailure(step, { isTimedOut: ran.timedOut === true }), `${step}: ${firstLine(ran.err)}`);
  }

  async function pinCoherenceInLockfile(checkout: string, npmFileTexts: NpmFileTexts, version: string): Promise<AdoptFailure | null> {
    const pinnedPackageText = packageTextWithCoherencePin(npmFileTexts['package.json'] ?? null, version);
    if (pinnedPackageText === null) return failure(CoherenceAdoptError.enum.failed, 'package.json is not a JSON object with an object devDependencies');
    const npmDirectory = await makeHostScratchDirectory('coherence-adopt-npm-');
    try {
      const emptyUserconfigPath = path.join(npmDirectory, 'empty-userconfig');
      await writeFile(emptyUserconfigPath, '', { flag: 'wx' });
      await writeFile(path.join(npmDirectory, 'package.json'), pinnedPackageText, { flag: 'wx' });
      const lockfileText = npmFileTexts['package-lock.json'] ?? null;
      if (lockfileText !== null) await writeFile(path.join(npmDirectory, 'package-lock.json'), lockfileText, { flag: 'wx' });
      const npmFailure = await runStep('npm-install', 'npm', coherenceNpmLockfileArgs(emptyUserconfigPath), {
        cwd: npmDirectory, timeoutMs: COHERENCE_ADOPT_TIMEOUT_MS.npmInstall, env: npmEnv(),
      });
      if (npmFailure) return npmFailure;
      for (const fileName of COHERENCE_ADOPT_NPM_FILES) await writeFile(path.join(checkout, fileName), await readFile(path.join(npmDirectory, fileName)));
      return null;
    } finally {
      await rm(npmDirectory, { recursive: true, force: true });
    }
  }

  async function installHooksWithShippedCli(checkout: string, shippedCliPath: string): Promise<AdoptFailure | null> {
    const placeholderPath = path.join(checkout, ...COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER.relativePath);
    const placeholderRoot = path.join(checkout, 'node_modules');
    try {
      await mkdir(path.dirname(placeholderPath), { recursive: true });
      await writeFile(placeholderPath, COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER.text, { flag: 'wx', mode: COHERENCE_ADOPT_HOOK_TARGET_PLACEHOLDER.mode });
      const hooksEnv = coherenceEnv(await factoryGitEnvironment(checkout));
      for (const host of COHERENCE_ADOPT_HOSTS) {
        const hooksFailure = await runStep('hooks-install', process.execPath, [shippedCliPath, ...coherenceHooksInstallArgs(host)], {
          cwd: checkout, timeoutMs: COHERENCE_ADOPT_TIMEOUT_MS.hooksInstall, env: hooksEnv,
        });
        if (hooksFailure) return hooksFailure;
      }
      return null;
    } finally {
      await rm(placeholderRoot, { recursive: true, force: true });
    }
  }

  async function installInCheckout(checkout: string, shipped: ShippedCoherence): Promise<AdoptFailure | null> {
    const trackedNodeModules = await trackedNodeModulesPaths(checkout);
    const trackedNodeModulesError = judgeCoherenceAdoptTrackedPaths(trackedNodeModules);
    if (trackedNodeModulesError !== null) return failure(trackedNodeModulesError, trackedNodeModules.slice(0, 5).join(', '));
    const ignoredPaths = await ignoredControlPaths(checkout);
    if (ignoredPaths.length > 0) return { ...failure(CoherenceAdoptError.enum.ignoresControlFiles, ignoredPaths.join(', ')), ignoredPaths };
    const symlinkedTarget = await findSymlinkedTarget(checkout);
    if (symlinkedTarget !== null) return failure(CoherenceAdoptError.enum.failed, `${symlinkedTarget} is a symbolic link`);
    const npmFileTexts = await readNpmFiles(checkout);
    if (!npmFileTexts.ok) return npmFileTexts;
    await writeFile(path.join(checkout, COHERENCE_CONFIG_FILENAME), COHERENCE_ADOPT_CONFIG_TEXT, { flag: 'wx' });
    const npmFailure = await pinCoherenceInLockfile(checkout, npmFileTexts.value, shipped.version);
    if (npmFailure) return npmFailure;
    const gitignorePath = path.join(checkout, '.gitignore');
    const gitignoreText = gitignoreTextWithNodeModules(await readTextOrNull(gitignorePath), await isNodeModulesIgnored(checkout));
    if (gitignoreText !== null) await writeFile(gitignorePath, gitignoreText);
    return installHooksWithShippedCli(checkout, shipped.cliPath);
  }

  async function commitInCheckout(checkout: string, version: string): Promise<AdoptOutcome<string>> {
    const gitOptions = { cwd: checkout, timeout: GIT_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER_BYTES };
    const { stdout: statusOutput } = await runHardenedGit(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], gitOptions);
    const verdict = judgeCoherenceAdoptPaths(pathsFromPorcelainStatus(statusOutput));
    if (!verdict.ok) {
      return failure(verdict.error, `unexpected paths: ${verdict.unexpectedPaths.join(', ') || 'none'}; missing paths: ${verdict.missingPaths.join(', ') || 'none'}`);
    }
    const message = coherenceAdoptCommitMessage(version);
    try {
      await runHardenedGit(['add', '--', ...verdict.paths], gitOptions);
      await runHardenedGit(['commit', '--quiet', '--no-verify', '-m', message.subject, '-m', message.body], gitOptions);
      return succeeded((await runHardenedGit(['rev-parse', 'HEAD'], gitOptions)).stdout.trim());
    } catch (error) {
      return stepFailure('commit', error);
    }
  }

  async function pushCommit(checkout: string, sha: string, branch: string): Promise<AdoptFailure | null> {
    try {
      await runHardenedGit(coherencePushArgs(sha, branch), { cwd: checkout, timeout: COHERENCE_ADOPT_TIMEOUT_MS.push, maxBuffer: COMMAND_MAX_BUFFER_BYTES });
      return null;
    } catch (error) {
      return stepFailure('push', error);
    }
  }

  async function adoptInCheckout(checkout: string, branch: string, shipped: ShippedCoherence): Promise<AdoptOutcome<string>> {
    const installFailure = await installInCheckout(checkout, shipped);
    if (installFailure) return installFailure;
    const committed = await commitInCheckout(checkout, shipped.version);
    if (!committed.ok) return committed;
    const pushFailure = await pushCommit(checkout, committed.value, branch);
    return pushFailure ?? committed;
  }

  async function adoptInPrivateCheckout(projectPath: string, branch: string, tipSha: string, shipped: ShippedCoherence): Promise<AdoptOutcome<string>> {
    const scratch = await makeHostScratchDirectory('coherence-adopt-');
    const checkout = path.join(scratch, 'checkout');
    let isStaged = false;
    try {
      const staged = await gitWorkspace.stageDetachedWorktree({ projectPath, worktreePath: checkout, sha: tipSha, disableHooks: true, disableRepoCommands: true });
      if (!staged.ok) return failure(CoherenceAdoptError.enum.failed, `stage: ${firstLine(staged.err ?? '')}`);
      isStaged = true;
      return await adoptInCheckout(checkout, branch, shipped);
    } finally {
      if (isStaged) {
        const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: checkout, disableHooks: true });
        if (!removed.ok) log.warn(`[coherence-adopt] could not remove the private checkout ${checkout}: ${firstLine(removed.err ?? '')}`);
      }
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function adoptProjectAt(projectPath: string): Promise<AdoptOutcome<string>> {
    if (!await isGitRepository(projectPath)) return failure(CoherenceAdoptError.enum.notGitRepository, projectPath);
    if (await gitWorkspace.originUrl({ projectPath }) === null) return failure(CoherenceAdoptError.enum.noOrigin, projectPath);
    const branch = await resolveIntegrationBranch(projectPath);
    if (!branch.ok) return branch;
    const tipSha = await fetchIntegrationTip(projectPath, branch.value);
    if (!tipSha.ok) return tipSha;
    if (await hasPathAtCommit(projectPath, tipSha.value, COHERENCE_CONFIG_FILENAME)) return failure(CoherenceAdoptError.enum.alreadyConfigured, tipSha.value);
    const shipped = await readShippedCoherence(cliPath);
    if (shipped === null) return failure(CoherenceAdoptError.enum.failed, 'Glimmervoid could not read the exact version of the Coherence package it ships');
    return adoptInPrivateCheckout(projectPath, branch.value, tipSha.value, shipped);
  }

  async function adoptProject(projectId: string): Promise<ProjectCoherenceAdoptResult> {
    const project = listProjects().find((candidate) => candidate.id === projectId);
    if (!project) return { projectId, ok: false, error: CoherenceAdoptError.enum.unknownProject };
    const adopted = await adoptProjectAt(project.path).catch((error: unknown) => failure(CoherenceAdoptError.enum.failed, firstLine(errorMessage(error))));
    if (!adopted.ok) {
      log.warn(`[coherence-adopt] adopting ${projectId} failed with ${adopted.error}: ${adopted.detail}`);
      return { projectId, ok: false, error: adopted.error, ...(adopted.ignoredPaths ? { ignoredPaths: adopted.ignoredPaths } : {}) };
    }
    void statusMessage().then(broadcastControl, (error: unknown) => log.warn(`[coherence-adopt] status after adopting ${projectId} failed: ${firstLine(errorMessage(error))}`));
    return { projectId, ok: true, sha: adopted.value };
  }

  function adopt(request: unknown): Promise<ProjectCoherenceAdoptResult> {
    const verdict = judgeCoherenceAdoptRequest(request);
    if (!verdict.ok) {
      const projectId: unknown = typeof request === 'object' && request !== null ? Reflect.get(request, 'projectId') : '';
      return Promise.resolve({ projectId: typeof projectId === 'string' ? projectId.slice(0, 128) : '', ok: false, error: verdict.error });
    }
    const running = inFlightByProject.get(verdict.projectId);
    if (running) return running;
    const started = adoptProject(verdict.projectId).finally(() => inFlightByProject.delete(verdict.projectId));
    inFlightByProject.set(verdict.projectId, started);
    return started;
  }

  async function projectStatus(project: AdoptProject): Promise<ProjectCoherenceStatus | null> {
    if (!await isGitRepository(project.path)) return null;
    if (await gitWorkspace.originUrl({ projectPath: project.path }) === null) return null;
    const tipSha = await readIntegrationTip(project.path);
    return { configured: tipSha !== null && await hasPathAtCommit(project.path, tipSha, COHERENCE_CONFIG_FILENAME) };
  }

  async function statusMessage(): Promise<ServerMessageOf<'project-coherence-status'>> {
    const projects: Record<string, ProjectCoherenceStatus> = {};
    for (const project of listProjects()) {
      const status = await projectStatus(project).catch((error: unknown) => {
        log.warn(`[coherence-adopt] reading the Coherence status of ${project.id} failed: ${firstLine(errorMessage(error))}`);
        return null;
      });
      if (status) projects[project.id] = status;
    }
    return { type: 'project-coherence-status', projects };
  }

  return { adopt, statusMessage };
}

type CoherenceAdopt = ReturnType<typeof createCoherenceAdopt>;

export { createCoherenceAdopt };
export type { CoherenceAdopt };

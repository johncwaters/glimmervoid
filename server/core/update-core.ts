import { InstallFlavor } from '../../shared/contracts/control-messages.ts';
import { UpdateChannel } from '../../shared/contracts/update-journal.ts';
import { compareReleaseVersions, isExperimentalBuild } from '../../shared/build-channel.ts';
import { REPO_SLUG } from '../../shared/repo.ts';
import { textOr } from '../../shared/coerce.ts';
import { FULL_SHA_RE, shortSha as abbreviateSha } from '../../shared/git-text.ts';

const NPM_PACKAGE_NAME = 'glimmervoid';
const NPM_GLOBAL_COMMAND = `npm install -g ${NPM_PACKAGE_NAME}@latest`;
const NODE_PTY_INSTALL_SCRIPT_FLAG = '--allow-scripts=node-pty';
const NPX_CACHE_DIRECTORY_NAME = '_npx';
const CLONE_COMMAND = 'git pull --ff-only && npm ci && npm run build';
const INSTALL_FLAVORS = new Set<string>(InstallFlavor.options);
const TAG_VERSION_RE = /^v(\d+\.\d+\.\d+(?:-next\.\d+)?)$/;
const DEPRECATION_MESSAGE_MAX_CHARS = 500;

interface ReleaseTag {
  version: string;
  sha: string | null;
}

function normalizeSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sha = value.trim().toLowerCase();
  if (!FULL_SHA_RE.test(sha)) return null;
  return sha;
}

function shortSha(value: unknown): string {
  return abbreviateSha(normalizeSha(value) ?? '');
}

function parseResolvedSha(resolved: unknown): string | null {
  if (typeof resolved !== 'string') return null;
  const fragmentAt = resolved.lastIndexOf('#');
  if (fragmentAt === -1) return null;
  return normalizeSha(resolved.slice(fragmentAt + 1));
}

function parseTagVersion(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const normalized = ref.trim().replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
  const matched = TAG_VERSION_RE.exec(normalized);
  if (!matched) return null;
  return matched[1];
}

function isNpxCachePath(packageRoot: unknown): boolean {
  if (typeof packageRoot !== 'string') return false;
  return packageRoot.split(/[\\/]/).includes(NPX_CACHE_DIRECTORY_NAME);
}

function decideInstallFlavor({ packageRoot, lockfileSha, gitHeadSha, hasGitDir, isInsideNodeModules }: {
  packageRoot?: unknown;
  lockfileSha?: unknown;
  gitHeadSha?: unknown;
  hasGitDir?: boolean;
  isInsideNodeModules?: boolean;
} = {}): { flavor: InstallFlavor; installedSha: string | null } {
  const fromLockfile = normalizeSha(lockfileSha);
  if (isNpxCachePath(packageRoot)) return { flavor: 'npx', installedSha: fromLockfile ?? normalizeSha(gitHeadSha) };
  if (fromLockfile) return { flavor: 'npm-global', installedSha: fromLockfile };
  const fromGitHead = normalizeSha(gitHeadSha);
  if (fromGitHead) return { flavor: 'npm-global', installedSha: fromGitHead };
  if (hasGitDir) return { flavor: 'clone', installedSha: null };
  if (isInsideNodeModules) return { flavor: 'npm-global', installedSha: null };
  return { flavor: 'unknown', installedSha: null };
}

function buildNpxCommand(latestVersion: unknown, platform: unknown): string {
  const packageSpec = `${NPM_PACKAGE_NAME}@${textOr(latestVersion, null) ?? 'latest'}`;
  if (platform === 'linux') return `npx ${NODE_PTY_INSTALL_SCRIPT_FLAG} ${packageSpec}`;
  return `npx ${packageSpec}`;
}

function buildNpmGlobalCommand(latestVersion: unknown, platform: unknown): string {
  const version = textOr(latestVersion, null);
  const installCommand = version ? `npm install -g ${NPM_PACKAGE_NAME}@${version}` : NPM_GLOBAL_COMMAND;
  if (platform === 'linux') return `${installCommand} ${NODE_PTY_INSTALL_SCRIPT_FLAG}`;
  return installCommand;
}

function buildUpdateCommand(flavor: unknown, latestVersion: unknown, platform?: unknown): string {
  if (flavor === 'npx') return buildNpxCommand(latestVersion, platform);
  if (flavor === 'npm-global') return buildNpmGlobalCommand(latestVersion, platform);
  return CLONE_COMMAND;
}

function buildReleaseUrl(version: unknown): string | null {
  const releaseVersion = textOr(version, null);
  if (!releaseVersion || isExperimentalBuild(releaseVersion)) return null;
  return `https://github.com/${REPO_SLUG}/releases/tag/v${releaseVersion}`;
}

function parseVersionTriple(version: unknown): number[] | null {
  if (typeof version !== 'string') return null;
  const core = version.trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const triple: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    triple.push(Number.parseInt(part, 10));
  }
  return triple;
}

function compareSemver(a: unknown, b: unknown): number {
  const ta = parseVersionTriple(a);
  const tb = parseVersionTriple(b);
  if (!ta || !tb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (ta[i] > tb[i]) return 1;
    if (ta[i] < tb[i]) return -1;
  }
  return 0;
}

function parseRegistryLatest(doc: unknown): ReleaseTag | null {
  if (!doc || typeof doc !== 'object') return null;
  const registryDocument = doc as { version?: unknown; gitHead?: unknown };
  const publishedVersion = textOr(registryDocument.version, null);
  if (!publishedVersion) return null;
  const version = parseTagVersion(`v${publishedVersion}`);
  if (!version) return null;
  return { version, sha: normalizeSha(registryDocument.gitHead) };
}

function pickNewestPublished(...publishedVersions: (ReleaseTag | null)[]): ReleaseTag | null {
  let newest: ReleaseTag | null = null;
  for (const published of publishedVersions) {
    if (!published) continue;
    if (newest && compareReleaseVersions(published.version, newest.version) <= 0) continue;
    newest = published;
  }
  return newest;
}

function parseRegistryDeprecation(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return null;
  const deprecated = (doc as { deprecated?: unknown }).deprecated;
  if (typeof deprecated !== 'string') return null;
  const message = deprecated.trim();
  if (!message) return null;
  return message.slice(0, DEPRECATION_MESSAGE_MAX_CHARS);
}

function normalizeFlavor(flavor: unknown): InstallFlavor {
  if (typeof flavor === 'string' && INSTALL_FLAVORS.has(flavor)) return flavor as InstallFlavor;
  return 'unknown';
}

function normalizeUpdateChannel(channel: unknown): UpdateChannel {
  const parsed = UpdateChannel.safeParse(channel);
  return parsed.success ? parsed.data : 'release';
}

function decideUpdateReason({ isReleaseAlreadyCheckedOut, reason }: {
  isReleaseAlreadyCheckedOut: boolean;
  reason: unknown;
}): string | null {
  if (isReleaseAlreadyCheckedOut) return 'release-already-checked-out';
  return textOr(reason, null);
}

function decideUpdateStatus({ installedSha, latestSha: remoteSha, currentVersion, latestVersion, flavor, platform, channel, reason, isLatestReleaseAncestorOfHead, deprecation }: {
  installedSha?: unknown;
  latestSha?: unknown;
  currentVersion?: unknown;
  latestVersion?: unknown;
  flavor?: unknown;
  platform?: unknown;
  channel?: unknown;
  reason?: unknown;
  isLatestReleaseAncestorOfHead?: unknown;
  deprecation?: unknown;
} = {}) {
  const currentSha = normalizeSha(installedSha);
  const latestSha = normalizeSha(remoteSha);
  const current = textOr(currentVersion, null);
  const latest = textOr(latestVersion, null);
  const normalizedFlavor = normalizeFlavor(flavor);
  const isTargetInCheckout = normalizedFlavor === 'clone'
    && isLatestReleaseAncestorOfHead === true
    && compareReleaseVersions(latest, current) > 0;
  const isReleaseAlreadyCheckedOut = isTargetInCheckout && !isExperimentalBuild(latest);
  return {
    updateAvailable: !isTargetInCheckout && compareReleaseVersions(latest, current) > 0,
    current,
    latest,
    currentSha,
    latestSha,
    releaseUrl: buildReleaseUrl(latest),
    command: buildUpdateCommand(flavor, latest, platform),
    flavor: normalizedFlavor,
    channel: normalizeUpdateChannel(channel),
    reason: decideUpdateReason({ isReleaseAlreadyCheckedOut, reason }),
    deprecation: isReleaseAlreadyCheckedOut ? null : parseRegistryDeprecation({ deprecated: deprecation }),
  };
}

function isCheckFresh(lastCheckAt: unknown, nowMs: unknown, ttlMs: unknown): boolean {
  if (!Number.isFinite(lastCheckAt)) return false;
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(ttlMs)) return false;
  const age = Number(nowMs) - Number(lastCheckAt);
  if (age < 0) return false;
  return age < Number(ttlMs);
}

export type { InstallFlavor };
export { normalizeSha, normalizeUpdateChannel, shortSha, parseResolvedSha, decideInstallFlavor, buildUpdateCommand, compareSemver, parseRegistryLatest, pickNewestPublished, parseRegistryDeprecation, decideUpdateStatus, isCheckFresh };

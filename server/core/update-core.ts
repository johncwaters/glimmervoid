import { BINARY_SWITCH_FLAVORS, InstallFlavor } from '../../shared/contracts/control-messages.ts';
import { UpdateChannel } from '../../shared/contracts/update-journal.ts';
import { compareReleaseVersions, isExperimentalBuild } from '../../shared/build-channel.ts';
import { REPO_SLUG } from '../../shared/repo.ts';
import { textOr } from '../../shared/coerce.ts';
import { FULL_SHA_RE, shortSha as abbreviateSha } from '../../shared/git-text.ts';

const UNIX_INSTALLER_NAME = 'glimmervoid-installer.sh';
const WINDOWS_INSTALLER_NAME = 'glimmervoid-installer.ps1';
const NPX_CACHE_DIRECTORY_NAME = '_npx';
const CLONE_COMMAND = 'git pull --ff-only && npm ci && npm run build';
const BINARY_UPDATER_NAME = 'glimmervoid-update';
const HOMEBREW_COMMAND = 'brew upgrade glimmervoid';
const HOMEBREW_CELLAR_DIRECTORY_NAME = 'Cellar';
const INSTALL_FLAVORS = new Set<string>(InstallFlavor.options);
const TAG_VERSION_RE = /^v(\d+\.\d+\.\d+(?:-next\.\d+)?)$/;
const SECURITY_NOTICE_MAX_CHARS = 500;

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

function parseRemoteTagSha(lsRemoteOutput: string, version: string): string | null {
  const tagRef = `refs/tags/v${version}`;
  const shaByRef = new Map(lsRemoteOutput.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length === 2).map(([sha, ref]) => [ref, sha]));
  return normalizeSha(shaByRef.get(`${tagRef}^{}`) ?? shaByRef.get(tagRef));
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

function isHomebrewCellarPath(executablePath: string): boolean {
  return executablePath.split(/[\\/]/).includes(HOMEBREW_CELLAR_DIRECTORY_NAME);
}

function decideInstallFlavor({ standaloneExecutablePath, packageRoot, lockfileSha, gitHeadSha, hasGitDir, isInsideNodeModules }: {
  standaloneExecutablePath?: string | null;
  packageRoot?: unknown;
  lockfileSha?: unknown;
  gitHeadSha?: unknown;
  hasGitDir?: boolean;
  isInsideNodeModules?: boolean;
} = {}): { flavor: InstallFlavor; installedSha: string | null } {
  if (standaloneExecutablePath) return { flavor: isHomebrewCellarPath(standaloneExecutablePath) ? 'homebrew' : 'binary', installedSha: null };
  const fromLockfile = normalizeSha(lockfileSha);
  if (isNpxCachePath(packageRoot)) return { flavor: 'npx', installedSha: fromLockfile ?? normalizeSha(gitHeadSha) };
  if (fromLockfile) return { flavor: 'npm-global', installedSha: fromLockfile };
  const fromGitHead = normalizeSha(gitHeadSha);
  if (fromGitHead) return { flavor: 'npm-global', installedSha: fromGitHead };
  if (hasGitDir) return { flavor: 'clone', installedSha: null };
  if (isInsideNodeModules) return { flavor: 'npm-global', installedSha: null };
  return { flavor: 'unknown', installedSha: null };
}

function isBinarySwitchFlavor(flavor: unknown): boolean {
  return typeof flavor === 'string' && BINARY_SWITCH_FLAVORS.has(flavor);
}

function installerFileName(platform: string): string {
  return platform === 'win32' ? WINDOWS_INSTALLER_NAME : UNIX_INSTALLER_NAME;
}

function installerUrl(version: string, platform: string): string {
  return `https://github.com/${REPO_SLUG}/releases/download/v${version}/${installerFileName(platform)}`;
}

function buildInstallerCommand(latestVersion: unknown, platform: string): string {
  const version = textOr(latestVersion, null);
  const url = version ? installerUrl(version, platform) : `https://github.com/${REPO_SLUG}/releases/latest/download/${installerFileName(platform)}`;
  if (platform === 'win32') return `powershell -ExecutionPolicy Bypass -c "irm ${url} | iex"`;
  return `curl --proto '=https' --tlsv1.2 -LsSf ${url} | sh`;
}

function buildUpdateCommand(flavor: unknown, latestVersion: unknown, platform: string = process.platform): string {
  if (isBinarySwitchFlavor(flavor)) return buildInstallerCommand(latestVersion, platform);
  if (flavor === 'binary') return BINARY_UPDATER_NAME;
  if (flavor === 'homebrew') return HOMEBREW_COMMAND;
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

const SECURITY_HEADING = /^### Security\b/m;

function parseLatestRelease(doc: unknown): { version: string; hasSecurityFix: boolean } | null {
  if (!doc || typeof doc !== 'object') return null;
  const release = doc as { tag_name?: unknown; body?: unknown };
  const version = parseTagVersion(release.tag_name);
  if (!version) return null;
  return { version, hasSecurityFix: SECURITY_HEADING.test(textOr(release.body, '')) };
}

function boundedSecurityNotice(notice: unknown): string | null {
  if (typeof notice !== 'string') return null;
  const message = notice.trim();
  if (!message) return null;
  return message.slice(0, SECURITY_NOTICE_MAX_CHARS);
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

function decideUpdateStatus({ installedSha, latestSha: remoteSha, currentVersion, latestVersion, flavor, channel, reason, isLatestReleaseAncestorOfHead, deprecation, platform = process.platform }: {
  installedSha?: unknown;
  latestSha?: unknown;
  currentVersion?: unknown;
  latestVersion?: unknown;
  flavor?: unknown;
  channel?: unknown;
  reason?: unknown;
  isLatestReleaseAncestorOfHead?: unknown;
  deprecation?: unknown;
  platform?: string;
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
    updateAvailable: isBinarySwitchFlavor(normalizedFlavor)
      ? latest !== null && compareReleaseVersions(latest, current) >= 0
      : !isTargetInCheckout && compareReleaseVersions(latest, current) > 0,
    current,
    latest,
    currentSha,
    latestSha,
    releaseUrl: buildReleaseUrl(latest),
    command: buildUpdateCommand(flavor, latest, platform),
    flavor: normalizedFlavor,
    channel: normalizeUpdateChannel(channel),
    reason: decideUpdateReason({ isReleaseAlreadyCheckedOut, reason }),
    deprecation: isReleaseAlreadyCheckedOut ? null : boundedSecurityNotice(deprecation),
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
export { BINARY_UPDATER_NAME, HOMEBREW_COMMAND, isBinarySwitchFlavor, installerFileName, installerUrl, normalizeSha, normalizeUpdateChannel, shortSha, parseResolvedSha, parseRemoteTagSha, decideInstallFlavor, buildUpdateCommand, compareSemver, parseLatestRelease, decideUpdateStatus, isCheckFresh };

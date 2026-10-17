import path from 'node:path';
import type { FilesystemConfig, FilesystemPathEntry, NetworkConfig } from '@anthropic-ai/sandbox-runtime';
import { encodeProjectDir } from '../../../session/core/conversation-history.ts';
import { HOOK_VIA_GUARDRAILS_PROXY_ENV } from '../../../session/core/guardrails-proxy-core.ts';
import { isPathInside } from '../../../shared/paths.ts';

type GuardrailsVendor = 'claude' | 'codex';

type GuardrailsNetworkAccess =
  | { access: 'none' }
  | { access: 'allowlist'; domains: readonly string[]; hookPort: number | null }
  | { access: 'open' };

interface GuardrailsCommitCheckout {
  checkout: string;
  gitDir: string;
}

interface GuardrailsLaunchState {
  scope: 'launch';
  cwd: string;
  agentSessionId: string | null;
}

type GuardrailsVendorHome = { scope: 'state' } | GuardrailsLaunchState;

type GuardrailLevel = 'standard' | 'strict';

interface GuardrailsRole {
  guardrailLevel?: GuardrailLevel;
  blockedPaths?: readonly string[];
  vendors: readonly GuardrailsVendor[];
  vendorHome: GuardrailsVendorHome;
  network: GuardrailsNetworkAccess;
  writableRoots: readonly string[];
  lockedCheckouts: readonly string[];
  commitCheckouts: readonly GuardrailsCommitCheckout[];
  readDenied: readonly string[];
  readableWithinDenied: readonly string[];
}

interface GuardrailsVendorLocation {
  stateFolder: string;
  configFiles: readonly string[];
  otherHomes: readonly string[];
}

interface GuardrailsHostPaths {
  homeDir: string;
  glimmervoidHome: string;
  glimmervoidConfigFile: string;
  tempDir: string;
  launchHomeDir: string;
  homeEntryNames: readonly string[];
  glimmervoidHomeEntryNames: readonly string[];
  vendorLocations: Readonly<Record<GuardrailsVendor, GuardrailsVendorLocation>>;
  unwrappedVendorHomes: readonly string[];
  relocatedXdgConfigHome: string | null;
}

interface GuardrailsHost extends GuardrailsHostPaths {
  existingPaths: ReadonlySet<string>;
  writeBlockedPaths: readonly string[];
}

type OpenNetworkPolicy = Pick<NetworkConfig, 'allowAllUnixSockets' | 'allowMachLookup'>;

type GuardrailsTerminalScope = 'own' | 'any';

interface GuardrailsPolicy {
  network: NetworkConfig | OpenNetworkPolicy;
  filesystem: FilesystemConfig;
  terminalScope: GuardrailsTerminalScope;
  allowAppleEvents: boolean;
}

interface GuardrailsLaunchHomeLink {
  linkPath: string;
  targetPath: string;
  isLogin: boolean;
}

interface GuardrailsLaunchPlan {
  launcher: 'runtime-cli' | 'open-network';
  policy: GuardrailsPolicy;
  launchEnv: Record<string, string>;
  guardedEnv: Record<string, string>;
  requiredDirectories: string[];
  launchHomeLinks: GuardrailsLaunchHomeLink[];
}

type GuardrailsLaunchPlanResult = { ok: true; plan: GuardrailsLaunchPlan } | { ok: false; reason: string };

interface VendorProfile {
  homeEntries: readonly string[];
  launchWritableFolders: (launch: GuardrailsLaunchState) => readonly string[];
  launchPrivateFolders: readonly string[];
  launchHomeEnvName: string | null;
  loginFiles: readonly string[];
  configEntries: readonly string[];
  apiDomains: readonly string[];
  launchEnv: Readonly<Record<string, string>>;
}

const VENDOR_PROFILES: Readonly<Record<GuardrailsVendor, VendorProfile>> = Object.freeze({
  claude: {
    homeEntries: ['.claude', '.claude.json'],
    launchWritableFolders: ({ cwd, agentSessionId }) => [
      path.join('projects', encodeProjectDir(cwd)),
      ...(agentSessionId === null ? [] : [path.join('session-env', agentSessionId)]),
    ],
    launchPrivateFolders: ['shell-snapshots'],
    launchHomeEnvName: null,
    loginFiles: ['.credentials.json'],
    configEntries: ['settings.json', 'settings.local.json', 'hooks', 'skills', 'plugins', 'commands', 'agents', 'CLAUDE.md', 'AGENTS.md'],
    apiDomains: ['api.anthropic.com', 'platform.claude.com'],
    launchEnv: { DISABLE_AUTOUPDATER: '1' },
  },
  codex: {
    homeEntries: ['.codex'],
    launchWritableFolders: () => [],
    launchPrivateFolders: [],
    launchHomeEnvName: 'CODEX_HOME',
    loginFiles: ['auth.json'],
    configEntries: ['config.toml', 'AGENTS.md', 'skills', 'rules', 'prompts', 'hooks.json'],
    apiDomains: ['chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'api.openai.com', '*.openai.com'],
    launchEnv: {},
  },
});

const GUARDRAILS_VENDORS: readonly GuardrailsVendor[] = Object.freeze(['claude', 'codex']);
const UNWRAPPED_VENDOR_HOME_ENTRIES: readonly string[] = Object.freeze(['.grok']);
const CREDENTIAL_HOME_ENTRIES: readonly string[] = Object.freeze(['.ssh', '.config/gh', 'Library/Keychains', '.git-credentials']);
const CLOUD_CREDENTIAL_HOME_ENTRIES: readonly string[] = Object.freeze(['.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.gnupg', '.netrc', '.npmrc']);
const STANDARD_LEVEL_USABLE_CREDENTIAL_ENTRIES: readonly string[] = Object.freeze(['Library/Keychains']);
const XDG_CONFIG_DEFAULT_HOME_PREFIX = '.config/';
const SHARED_TEMP_DIRS: readonly string[] = Object.freeze(['/tmp/claude', '/private/tmp/claude']);
const SHARED_HOME_WRITE_ENTRIES: readonly string[] = Object.freeze(['.npm/_logs']);
const GUARDRAILS_PLACEHOLDER_NAMES: readonly string[] = Object.freeze([
  '.bash_profile', '.bashrc', '.claude', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc',
]);
const WHOLE_FILESYSTEM = '/';
const GUARDRAILS_TEMP_FOLDER = 'guardrails-temp';
const GLIMMERVOID_CONFIG_SIBLING_ENTRIES: readonly string[] = Object.freeze([
  'bin', 'pairings.json', 'pairings-seen.json', 'plans', 'telegram-outbox.json', 'traces', 'uploads', 'usage-budget-state.json', 'usage-lanes.json', 'usage-warehouse.json',
  'visions-intent.json',
]);
const GLIMMERVOID_HOME_STATE_ENTRIES: readonly string[] = Object.freeze([
  'benchmark-runs', 'benchmarks', 'config.json', 'factory', 'issues-cache.json', 'knowledge-graph', 'litellm-pricing.json', 'my-prs-state.json', 'my-prs-work', 'posthog-reports',
  'posthog-state.json', 'posthog-work', 'recordings', 'guardrails-homes', 'guardrails-policies', 'sane-yolo', 'scratch', 'sounds', 'team-review-repos', 'team-review-state.json',
  'team-review-work', 'team-review-worktrees', 'telemetry-pending-crash.json', 'telemetry.json', 'tmp', 'update-check.json', 'update-journal.json', 'workflows-state.json',
  'workflows-work',
]);
const RUNTIME_MANDATORY_CLAUDE_DENY_FOLDERS: readonly string[] = Object.freeze(['commands', 'agents']);
const GUARDED_PROXY_BYPASS = 'localhost,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
const HOOK_LOOPBACK_HOST = '127.0.0.1';
const AGENT_SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const STANDARD_OPEN_NETWORK: OpenNetworkPolicy = Object.freeze({ allowAllUnixSockets: true, allowMachLookup: ['*'] });
const STRICT_OPEN_NETWORK: OpenNetworkPolicy = Object.freeze({ allowAllUnixSockets: false });

function unique(entries: readonly string[]): string[] {
  return [...new Set(entries)];
}

function literalEntries(entryPaths: readonly string[]): FilesystemPathEntry[] {
  return unique(entryPaths).map((entryPath) => ({ path: entryPath, literal: true }));
}

function homePaths(host: GuardrailsHostPaths, homeEntries: readonly string[]): string[] {
  return homeEntries.map((entry) => path.join(host.homeDir, entry));
}

function isInsideAny(parents: readonly string[], child: string): boolean {
  return parents.some((parent) => isPathInside(parent, child));
}

function vendorStatePaths(host: GuardrailsHostPaths, vendor: GuardrailsVendor, stateFolderEntries: readonly string[]): string[] {
  return stateFolderEntries.map((entry) => path.join(host.vendorLocations[vendor].stateFolder, entry));
}

function vendorHeldPaths(host: GuardrailsHostPaths, vendor: GuardrailsVendor): string[] {
  const { stateFolder, configFiles, otherHomes } = host.vendorLocations[vendor];
  return [stateFolder, ...configFiles, ...otherHomes];
}

function launchHomeOf(host: GuardrailsHostPaths, vendor: GuardrailsVendor): string {
  return path.join(host.launchHomeDir, vendor);
}

function vendorsWithLaunchHome(role: GuardrailsRole): GuardrailsVendor[] {
  if (role.vendorHome.scope === 'state') return [];
  return role.vendors.filter((vendor) => VENDOR_PROFILES[vendor].launchHomeEnvName !== null);
}

function vendorWritableFolders(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  const { vendorHome } = role;
  if (vendorHome.scope === 'state') return role.vendors.map((vendor) => host.vendorLocations[vendor].stateFolder);
  return role.vendors.flatMap((vendor) => {
    const profile = VENDOR_PROFILES[vendor];
    if (profile.launchHomeEnvName !== null) return [launchHomeOf(host, vendor)];
    return vendorStatePaths(host, vendor, profile.launchWritableFolders(vendorHome));
  });
}

function launchPrivateFolders(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  if (role.vendorHome.scope === 'state') return [];
  return role.vendors.flatMap((vendor) => vendorStatePaths(host, vendor, VENDOR_PROFILES[vendor].launchPrivateFolders));
}

function launchHomeLinkCandidates(role: GuardrailsRole, host: GuardrailsHostPaths): GuardrailsLaunchHomeLink[] {
  return vendorsWithLaunchHome(role).flatMap((vendor) => {
    const { configEntries, loginFiles } = VENDOR_PROFILES[vendor];
    const linkFor = (entry: string, isLogin: boolean) => ({
      linkPath: path.join(launchHomeOf(host, vendor), entry), targetPath: path.join(host.vendorLocations[vendor].stateFolder, entry), isLogin,
    });
    return [...configEntries.map((entry) => linkFor(entry, false)), ...loginFiles.map((entry) => linkFor(entry, true))];
  });
}

function launchHomeEnv(role: GuardrailsRole, host: GuardrailsHostPaths): Record<string, string> {
  return Object.fromEntries(vendorsWithLaunchHome(role).flatMap((vendor) => {
    const envName = VENDOR_PROFILES[vendor].launchHomeEnvName;
    return envName === null ? [] : [[envName, launchHomeOf(host, vendor)]];
  }));
}

function vendorLoginFiles(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  return role.vendors.flatMap((vendor) => vendorStatePaths(host, vendor, VENDOR_PROFILES[vendor].loginFiles));
}

function roleWritableRoots(role: GuardrailsRole): string[] {
  return [...role.writableRoots, ...role.lockedCheckouts, ...role.commitCheckouts.flatMap(({ checkout, gitDir }) => [checkout, gitDir])];
}

function alwaysWritablePaths(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  return [host.tempDir, ...roleWritableRoots(role), ...vendorWritableFolders(role, host)];
}

function commitCheckoutWriteDenies({ checkout, gitDir }: GuardrailsCommitCheckout): string[] {
  const gitPointer = path.join(checkout, '.git');
  const gitDirDenies = [path.join(gitDir, 'hooks'), path.join(gitDir, 'config')];
  if (path.resolve(gitPointer) === path.resolve(gitDir)) return gitDirDenies;
  return [gitPointer, ...gitDirDenies];
}

function writeDeniesWhenPresent(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  const writablePaths = alwaysWritablePaths(role, host);
  const sharedHomeWrites = homePaths(host, SHARED_HOME_WRITE_ENTRIES).filter((sharedPath) => !isInsideAny(roleWritableRoots(role), sharedPath));
  const vendorConfig = role.vendors
    .flatMap((vendor) => [...vendorStatePaths(host, vendor, VENDOR_PROFILES[vendor].configEntries), ...host.vendorLocations[vendor].configFiles])
    .filter((configPath) => isInsideAny(writablePaths, configPath));
  return [...SHARED_TEMP_DIRS, ...sharedHomeWrites, ...vendorConfig, ...role.commitCheckouts.flatMap(commitCheckoutWriteDenies)];
}

function lockedCheckoutWriteDenies(role: GuardrailsRole): string[] {
  return role.lockedCheckouts.flatMap((checkout) => [path.join(checkout, '.git'), path.join(checkout, '.claude')]);
}

function lockedClaudeMountPoints(role: GuardrailsRole): string[] {
  return role.lockedCheckouts.flatMap((checkout) => RUNTIME_MANDATORY_CLAUDE_DENY_FOLDERS.map((folder) => path.join(checkout, '.claude', folder)));
}

function guardrailsPlaceholderPaths(role: GuardrailsRole): string[] {
  const workingFolders = role.vendorHome.scope === 'launch' ? [role.vendorHome.cwd] : [];
  const workingFolderPlaceholders = workingFolders.flatMap((workingFolder) => GUARDRAILS_PLACEHOLDER_NAMES.map((placeholderName) => path.join(workingFolder, placeholderName)));
  return unique([...workingFolderPlaceholders, ...lockedCheckoutWriteDenies(role)]);
}

function homeEntriesNamedLike(host: GuardrailsHostPaths, homeEntries: readonly string[]): string[] {
  return host.homeEntryNames.filter((entryName) => homeEntries.some((homeEntry) => entryName.startsWith(homeEntry)));
}

function relocatedXdgConfigPaths(host: GuardrailsHostPaths, homeEntries: readonly string[]): string[] {
  const xdgConfigHome = host.relocatedXdgConfigHome;
  if (xdgConfigHome === null) return [];
  return homeEntries
    .filter((entry) => entry.startsWith(XDG_CONFIG_DEFAULT_HOME_PREFIX))
    .map((entry) => path.join(xdgConfigHome, entry.slice(XDG_CONFIG_DEFAULT_HOME_PREFIX.length)));
}

function isStandardLevel(role: GuardrailsRole): boolean {
  return role.guardrailLevel === 'standard';
}

function blockedCredentialHomeEntries(role: GuardrailsRole): string[] {
  const credentialHomeEntries = [...CREDENTIAL_HOME_ENTRIES, ...CLOUD_CREDENTIAL_HOME_ENTRIES];
  if (!isStandardLevel(role)) return credentialHomeEntries;
  return credentialHomeEntries.filter((entry) => !STANDARD_LEVEL_USABLE_CREDENTIAL_ENTRIES.includes(entry));
}

function credentialWriteBlocks(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  const credentialHomeEntries = blockedCredentialHomeEntries(role);
  return [...homePaths(host, credentialHomeEntries), ...relocatedXdgConfigPaths(host, credentialHomeEntries)];
}

function glimmervoidStateWriteBlocks(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  const keptWritable = alwaysWritablePaths(role, host);
  const configFolder = path.dirname(host.glimmervoidConfigFile);
  const homeEntryNames = [...GLIMMERVOID_HOME_STATE_ENTRIES, ...GLIMMERVOID_CONFIG_SIBLING_ENTRIES, ...host.glimmervoidHomeEntryNames];
  const homeEntries = homeEntryNames.map((entryName) => path.join(host.glimmervoidHome, entryName));
  const configSiblings = GLIMMERVOID_CONFIG_SIBLING_ENTRIES.map((entryName) => path.join(configFolder, entryName));
  return unique([host.glimmervoidConfigFile, ...homeEntries, ...configSiblings])
    .filter((entryPath) => !keptWritable.some((writable) => isPathInside(entryPath, writable)));
}

function standardWriteBlockCandidates(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  if (!isStandardLevel(role)) return [];
  return unique([...credentialWriteBlocks(role, host), ...glimmervoidStateWriteBlocks(role, host), ...(role.blockedPaths ?? [])]);
}

function readDeniedPaths(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  const otherVendors = GUARDRAILS_VENDORS.filter((vendor) => !role.vendors.includes(vendor));
  const otherVendorHomeEntries = [...otherVendors.flatMap((vendor) => VENDOR_PROFILES[vendor].homeEntries), ...UNWRAPPED_VENDOR_HOME_ENTRIES];
  const credentialHomeEntries = blockedCredentialHomeEntries(role);
  return [
    ...homePaths(host, [...credentialHomeEntries, ...otherVendorHomeEntries, ...homeEntriesNamedLike(host, otherVendorHomeEntries)]),
    ...relocatedXdgConfigPaths(host, credentialHomeEntries),
    ...otherVendors.flatMap((vendor) => vendorHeldPaths(host, vendor)),
    ...host.unwrappedVendorHomes,
    host.glimmervoidHome,
    ...launchPrivateFolders(role, host),
    ...role.readDenied,
  ];
}

function guardrailsPolicyProbePaths(role: GuardrailsRole, host: GuardrailsHostPaths): string[] {
  return unique([...writeDeniesWhenPresent(role, host), ...vendorLoginFiles(role, host), ...launchHomeLinkCandidates(role, host).map((link) => link.targetPath)]);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hostNamedPaths(host: GuardrailsHostPaths): string[] {
  const relocatedXdgConfigHomes = host.relocatedXdgConfigHome === null ? [] : [host.relocatedXdgConfigHome];
  return [host.homeDir, host.glimmervoidHome, host.glimmervoidConfigFile, host.tempDir, host.launchHomeDir, ...relocatedXdgConfigHomes, ...host.unwrappedVendorHomes, ...GUARDRAILS_VENDORS.flatMap((vendor) => vendorHeldPaths(host, vendor))];
}

function guardrailsRoleRefusal(role: GuardrailsRole, host: GuardrailsHostPaths): string | null {
  const launchCwds = role.vendorHome.scope === 'launch' ? [role.vendorHome.cwd] : [];
  const namedPaths = [...hostNamedPaths(host), ...roleWritableRoots(role), ...role.readDenied, ...role.readableWithinDenied, ...launchCwds];
  const relativePath = namedPaths.find((namedPath) => !path.isAbsolute(namedPath));
  if (relativePath !== undefined) return `guardrails policy path is not absolute: ${relativePath}`;
  const rootOverProtectedHome = [...roleWritableRoots(role), ...vendorWritableFolders(role, host)].find((root) => isPathInside(root, host.homeDir) || isPathInside(root, host.glimmervoidHome));
  if (rootOverProtectedHome !== undefined) return `writable root ${rootOverProtectedHome} contains the home folder or the Glimmervoid home`;
  const writablePaths = alwaysWritablePaths(role, host);
  const reallowedAncestor = role.readableWithinDenied.find((readable) => writablePaths.some((writable) => isPathInside(readable, writable, { allowEqual: false })));
  if (reallowedAncestor !== undefined) return `readable path ${reallowedAncestor} is an ancestor of a writable root`;
  if (role.network.access === 'allowlist' && role.network.hookPort !== null && !isValidPort(role.network.hookPort)) return 'hook listener port is invalid';
  const agentSessionId = role.vendorHome.scope === 'launch' ? role.vendorHome.agentSessionId : null;
  if (agentSessionId !== null && !AGENT_SESSION_ID_SHAPE.test(agentSessionId)) return 'agent session id is invalid';
  return null;
}

function networkPolicy(role: GuardrailsRole): GuardrailsPolicy['network'] {
  if (role.network.access === 'open') return isStandardLevel(role) ? { ...STANDARD_OPEN_NETWORK } : { ...STRICT_OPEN_NETWORK };
  if (role.network.access === 'none') return { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false };
  const hookEndpoint = role.network.hookPort === null ? [] : [`${HOOK_LOOPBACK_HOST}:${role.network.hookPort}`];
  const vendorDomains = role.vendors.flatMap((vendor) => VENDOR_PROFILES[vendor].apiDomains);
  return {
    allowedDomains: unique([...hookEndpoint, ...vendorDomains, ...role.network.domains]),
    deniedDomains: [],
    strictAllowlist: true,
    allowLocalBinding: false,
    allowAllUnixSockets: false,
  };
}

function guardedEnvFor(role: GuardrailsRole, host: GuardrailsHostPaths): Record<string, string> {
  if (role.network.access === 'allowlist') return { NO_PROXY: GUARDED_PROXY_BYPASS, no_proxy: GUARDED_PROXY_BYPASS, [HOOK_VIA_GUARDRAILS_PROXY_ENV]: '1' };
  if (role.network.access === 'open') return { TMPDIR: host.tempDir };
  return {};
}

function filesystemWrites(role: GuardrailsRole, host: GuardrailsHost, writablePaths: readonly string[]): Pick<FilesystemConfig, 'allowWrite' | 'denyWrite'> {
  if (isStandardLevel(role)) return { allowWrite: literalEntries([WHOLE_FILESYSTEM, ...writablePaths]), denyWrite: literalEntries(host.writeBlockedPaths) };
  const isPresent = (candidate: string) => host.existingPaths.has(candidate);
  return {
    allowWrite: literalEntries(writablePaths),
    denyWrite: literalEntries([...writeDeniesWhenPresent(role, host).filter(isPresent), ...lockedCheckoutWriteDenies(role)]),
  };
}

function buildGuardrailsLaunchPlan(role: GuardrailsRole, host: GuardrailsHost): GuardrailsLaunchPlanResult {
  const refusal = guardrailsRoleRefusal(role, host);
  if (refusal !== null) return { ok: false, reason: refusal };
  const isPresent = (candidate: string) => host.existingPaths.has(candidate);
  const writablePaths = [...alwaysWritablePaths(role, host), ...vendorLoginFiles(role, host).filter(isPresent)];
  const readDenied = readDeniedPaths(role, host);
  const writableWithinDenied = writablePaths.filter((writable) => isInsideAny(readDenied, writable));
  return {
    ok: true,
    plan: {
      launcher: role.network.access === 'open' ? 'open-network' : 'runtime-cli',
      policy: {
        network: networkPolicy(role),
        filesystem: {
          denyRead: literalEntries(readDenied),
          allowRead: literalEntries([...writableWithinDenied, ...role.readableWithinDenied]),
          ...filesystemWrites(role, host, writablePaths),
        },
        terminalScope: isStandardLevel(role) ? 'any' : 'own',
        allowAppleEvents: isStandardLevel(role),
      },
      launchEnv: Object.assign({ CLAUDE_CODE_TMPDIR: host.tempDir }, ...role.vendors.map((vendor) => VENDOR_PROFILES[vendor].launchEnv), launchHomeEnv(role, host)),
      guardedEnv: guardedEnvFor(role, host),
      requiredDirectories: unique([host.tempDir, ...vendorWritableFolders(role, host), ...launchPrivateFolders(role, host)]),
      launchHomeLinks: launchHomeLinkCandidates(role, host).filter((link) => isPresent(link.targetPath)),
    },
  };
}

export { buildGuardrailsLaunchPlan, lockedClaudeMountPoints, GUARDRAILS_PLACEHOLDER_NAMES, GUARDRAILS_TEMP_FOLDER, guardrailsPlaceholderPaths, guardrailsPolicyProbePaths, standardWriteBlockCandidates };
export type { GuardrailsHost, GuardrailsHostPaths, GuardrailsLaunchPlan, GuardrailsNetworkAccess, GuardrailsRole };

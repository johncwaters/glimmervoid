import path from 'node:path';
import type { FilesystemConfig, FilesystemPathEntry, NetworkConfig } from '@anthropic-ai/sandbox-runtime';
import { HOOK_VIA_SANDBOX_PROXY_ENV } from '../../session/core/sandbox-proxy-core.ts';
import { isPathInside } from '../../shared/paths.ts';

type SandboxVendor = 'claude' | 'codex';

type SandboxNetworkAccess =
  | { access: 'none' }
  | { access: 'allowlist'; domains: readonly string[]; hookPort: number | null }
  | { access: 'open' };

interface SandboxCommitCheckout {
  checkout: string;
  gitDir: string;
}

interface SandboxRole {
  vendors: readonly SandboxVendor[];
  vendorHome: 'lane' | 'state';
  network: SandboxNetworkAccess;
  writableRoots: readonly string[];
  lockedCheckouts: readonly string[];
  commitCheckouts: readonly SandboxCommitCheckout[];
  readDenied: readonly string[];
  readableWithinDenied: readonly string[];
}

interface SandboxVendorLocation {
  stateFolder: string;
  configFiles: readonly string[];
  otherHomes: readonly string[];
}

interface SandboxHostPaths {
  homeDir: string;
  glimmervoidHome: string;
  tempDir: string;
  homeEntryNames: readonly string[];
  vendorLocations: Readonly<Record<SandboxVendor, SandboxVendorLocation>>;
  unwrappedVendorHomes: readonly string[];
  relocatedXdgConfigHome: string | null;
}

interface SandboxHost extends SandboxHostPaths {
  existingPaths: ReadonlySet<string>;
}

interface SandboxPolicy {
  network: NetworkConfig | { allowAllUnixSockets: false };
  filesystem: FilesystemConfig;
}

interface SandboxLaunchPlan {
  launcher: 'runtime-cli' | 'open-network';
  policy: SandboxPolicy;
  launchEnv: Record<string, string>;
  sandboxedEnv: Record<string, string>;
  requiredDirectories: string[];
}

type SandboxLaunchPlanResult = { ok: true; plan: SandboxLaunchPlan } | { ok: false; reason: string };

interface VendorProfile {
  homeEntries: readonly string[];
  laneWritableFolders: readonly string[];
  stateWritableFolders: readonly string[];
  loginFiles: readonly string[];
  configEntries: readonly string[];
  apiDomains: readonly string[];
  launchEnv: Readonly<Record<string, string>>;
}

const VENDOR_PROFILES: Readonly<Record<SandboxVendor, VendorProfile>> = Object.freeze({
  claude: {
    homeEntries: ['.claude', '.claude.json'],
    laneWritableFolders: ['projects', 'session-env'],
    stateWritableFolders: ['.'],
    loginFiles: ['.credentials.json'],
    configEntries: ['settings.json', 'settings.local.json', 'hooks', 'skills', 'plugins', 'commands', 'agents', 'CLAUDE.md', 'AGENTS.md'],
    apiDomains: ['api.anthropic.com', 'platform.claude.com'],
    launchEnv: { DISABLE_AUTOUPDATER: '1' },
  },
  codex: {
    homeEntries: ['.codex'],
    laneWritableFolders: ['.'],
    stateWritableFolders: ['.'],
    loginFiles: [],
    configEntries: ['config.toml', 'AGENTS.md', 'skills', 'rules', 'prompts', 'hooks.json'],
    apiDomains: ['chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'api.openai.com', '*.openai.com'],
    launchEnv: {},
  },
});

const SANDBOX_VENDORS: readonly SandboxVendor[] = Object.freeze(['claude', 'codex']);
const UNWRAPPED_VENDOR_HOME_ENTRIES: readonly string[] = Object.freeze(['.grok']);
const CREDENTIAL_HOME_ENTRIES: readonly string[] = Object.freeze(['.ssh', '.config/gh', 'Library/Keychains', '.git-credentials']);
const CLOUD_CREDENTIAL_HOME_ENTRIES: readonly string[] = Object.freeze(['.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.gnupg', '.netrc', '.npmrc']);
const XDG_CONFIG_DEFAULT_HOME_PREFIX = '.config/';
const SHARED_TEMP_DIRS: readonly string[] = Object.freeze(['/tmp/claude', '/private/tmp/claude']);
const SHARED_HOME_WRITE_ENTRIES: readonly string[] = Object.freeze(['.npm/_logs']);
const SANDBOXED_PROXY_BYPASS = 'localhost,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
const HOOK_LOOPBACK_HOST = '127.0.0.1';

function unique(entries: readonly string[]): string[] {
  return [...new Set(entries)];
}

function literalEntries(entryPaths: readonly string[]): FilesystemPathEntry[] {
  return unique(entryPaths).map((entryPath) => ({ path: entryPath, literal: true }));
}

function homePaths(host: SandboxHostPaths, homeEntries: readonly string[]): string[] {
  return homeEntries.map((entry) => path.join(host.homeDir, entry));
}

function isInsideAny(parents: readonly string[], child: string): boolean {
  return parents.some((parent) => isPathInside(parent, child));
}

function vendorStatePaths(host: SandboxHostPaths, vendor: SandboxVendor, stateFolderEntries: readonly string[]): string[] {
  return stateFolderEntries.map((entry) => path.join(host.vendorLocations[vendor].stateFolder, entry));
}

function vendorHeldPaths(host: SandboxHostPaths, vendor: SandboxVendor): string[] {
  const { stateFolder, configFiles, otherHomes } = host.vendorLocations[vendor];
  return [stateFolder, ...configFiles, ...otherHomes];
}

function vendorWritableFolders(role: SandboxRole, host: SandboxHostPaths): string[] {
  return role.vendors.flatMap((vendor) => {
    const profile = VENDOR_PROFILES[vendor];
    return vendorStatePaths(host, vendor, role.vendorHome === 'state' ? profile.stateWritableFolders : profile.laneWritableFolders);
  });
}

function vendorLoginFiles(role: SandboxRole, host: SandboxHostPaths): string[] {
  return role.vendors.flatMap((vendor) => vendorStatePaths(host, vendor, VENDOR_PROFILES[vendor].loginFiles));
}

function roleWritableRoots(role: SandboxRole): string[] {
  return [...role.writableRoots, ...role.lockedCheckouts, ...role.commitCheckouts.flatMap(({ checkout, gitDir }) => [checkout, gitDir])];
}

function alwaysWritablePaths(role: SandboxRole, host: SandboxHostPaths): string[] {
  return [host.tempDir, ...roleWritableRoots(role), ...vendorWritableFolders(role, host)];
}

function commitCheckoutWriteDenies({ checkout, gitDir }: SandboxCommitCheckout): string[] {
  const gitPointer = path.join(checkout, '.git');
  const gitDirDenies = [path.join(gitDir, 'hooks'), path.join(gitDir, 'config')];
  if (path.resolve(gitPointer) === path.resolve(gitDir)) return gitDirDenies;
  return [gitPointer, ...gitDirDenies];
}

function writeDeniesWhenPresent(role: SandboxRole, host: SandboxHostPaths): string[] {
  const writablePaths = alwaysWritablePaths(role, host);
  const sharedHomeWrites = homePaths(host, SHARED_HOME_WRITE_ENTRIES).filter((sharedPath) => !isInsideAny(roleWritableRoots(role), sharedPath));
  const vendorConfig = role.vendors
    .flatMap((vendor) => [...vendorStatePaths(host, vendor, VENDOR_PROFILES[vendor].configEntries), ...host.vendorLocations[vendor].configFiles])
    .filter((configPath) => isInsideAny(writablePaths, configPath));
  return [...SHARED_TEMP_DIRS, ...sharedHomeWrites, ...vendorConfig, ...role.commitCheckouts.flatMap(commitCheckoutWriteDenies)];
}

function lockedCheckoutWriteDenies(role: SandboxRole): string[] {
  return role.lockedCheckouts.flatMap((checkout) => [path.join(checkout, '.git'), path.join(checkout, '.claude')]);
}

function homeEntriesNamedLike(host: SandboxHostPaths, homeEntries: readonly string[]): string[] {
  return host.homeEntryNames.filter((entryName) => homeEntries.some((homeEntry) => entryName.startsWith(homeEntry)));
}

function relocatedXdgConfigPaths(host: SandboxHostPaths, homeEntries: readonly string[]): string[] {
  const xdgConfigHome = host.relocatedXdgConfigHome;
  if (xdgConfigHome === null) return [];
  return homeEntries
    .filter((entry) => entry.startsWith(XDG_CONFIG_DEFAULT_HOME_PREFIX))
    .map((entry) => path.join(xdgConfigHome, entry.slice(XDG_CONFIG_DEFAULT_HOME_PREFIX.length)));
}

function readDeniedPaths(role: SandboxRole, host: SandboxHostPaths): string[] {
  const otherVendors = SANDBOX_VENDORS.filter((vendor) => !role.vendors.includes(vendor));
  const otherVendorHomeEntries = [...otherVendors.flatMap((vendor) => VENDOR_PROFILES[vendor].homeEntries), ...UNWRAPPED_VENDOR_HOME_ENTRIES];
  const credentialHomeEntries = [...CREDENTIAL_HOME_ENTRIES, ...CLOUD_CREDENTIAL_HOME_ENTRIES];
  return [
    ...homePaths(host, [...credentialHomeEntries, ...otherVendorHomeEntries, ...homeEntriesNamedLike(host, otherVendorHomeEntries)]),
    ...relocatedXdgConfigPaths(host, credentialHomeEntries),
    ...otherVendors.flatMap((vendor) => vendorHeldPaths(host, vendor)),
    ...host.unwrappedVendorHomes,
    host.glimmervoidHome,
    ...role.readDenied,
  ];
}

function sandboxPolicyProbePaths(role: SandboxRole, host: SandboxHostPaths): string[] {
  return unique([...writeDeniesWhenPresent(role, host), ...vendorLoginFiles(role, host)]);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function hostNamedPaths(host: SandboxHostPaths): string[] {
  const relocatedXdgConfigHomes = host.relocatedXdgConfigHome === null ? [] : [host.relocatedXdgConfigHome];
  return [host.homeDir, host.glimmervoidHome, host.tempDir, ...relocatedXdgConfigHomes, ...host.unwrappedVendorHomes, ...SANDBOX_VENDORS.flatMap((vendor) => vendorHeldPaths(host, vendor))];
}

function sandboxRoleRefusal(role: SandboxRole, host: SandboxHostPaths): string | null {
  const namedPaths = [...hostNamedPaths(host), ...roleWritableRoots(role), ...role.readDenied, ...role.readableWithinDenied];
  const relativePath = namedPaths.find((namedPath) => !path.isAbsolute(namedPath));
  if (relativePath !== undefined) return `sandbox policy path is not absolute: ${relativePath}`;
  const rootOverProtectedHome = [...roleWritableRoots(role), ...vendorWritableFolders(role, host)].find((root) => isPathInside(root, host.homeDir) || isPathInside(root, host.glimmervoidHome));
  if (rootOverProtectedHome !== undefined) return `writable root ${rootOverProtectedHome} contains the home folder or the Glimmervoid home`;
  const writablePaths = alwaysWritablePaths(role, host);
  const reallowedAncestor = role.readableWithinDenied.find((readable) => writablePaths.some((writable) => isPathInside(readable, writable, { allowEqual: false })));
  if (reallowedAncestor !== undefined) return `readable path ${reallowedAncestor} is an ancestor of a writable root`;
  if (role.network.access === 'allowlist' && role.network.hookPort !== null && !isValidPort(role.network.hookPort)) return 'hook listener port is invalid';
  return null;
}

function networkPolicy(role: SandboxRole): SandboxPolicy['network'] {
  if (role.network.access === 'open') return { allowAllUnixSockets: false };
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

function sandboxedEnvFor(role: SandboxRole, host: SandboxHostPaths): Record<string, string> {
  if (role.network.access === 'allowlist') return { NO_PROXY: SANDBOXED_PROXY_BYPASS, no_proxy: SANDBOXED_PROXY_BYPASS, [HOOK_VIA_SANDBOX_PROXY_ENV]: '1' };
  if (role.network.access === 'open') return { TMPDIR: host.tempDir };
  return {};
}

function buildSandboxLaunchPlan(role: SandboxRole, host: SandboxHost): SandboxLaunchPlanResult {
  const refusal = sandboxRoleRefusal(role, host);
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
          allowWrite: literalEntries(writablePaths),
          denyWrite: literalEntries([...writeDeniesWhenPresent(role, host).filter(isPresent), ...lockedCheckoutWriteDenies(role)]),
        },
      },
      launchEnv: Object.assign({ CLAUDE_CODE_TMPDIR: host.tempDir }, ...role.vendors.map((vendor) => VENDOR_PROFILES[vendor].launchEnv)),
      sandboxedEnv: sandboxedEnvFor(role, host),
      requiredDirectories: unique([host.tempDir, ...vendorWritableFolders(role, host)]),
    },
  };
}

export { buildSandboxLaunchPlan, CREDENTIAL_HOME_ENTRIES, sandboxPolicyProbePaths };
export type { SandboxHost, SandboxLaunchPlan, SandboxNetworkAccess, SandboxRole };

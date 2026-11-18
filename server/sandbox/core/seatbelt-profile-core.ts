import path from 'node:path';
import { isPathInside } from '../../../shared/paths.ts';

const SRT_MACOS_BASELINE_RULES: readonly string[] = Object.freeze([
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow process-info* (target same-sandbox))',
  '(allow signal (target same-sandbox))',
  '(allow mach-priv-task-port (target same-sandbox))',
  '(allow user-preference-read)',
  '(allow mach-lookup',
  '  (global-name "com.apple.audio.systemsoundserver")',
  '  (global-name "com.apple.distributed_notifications@Uv3")',
  '  (global-name "com.apple.FontObjectsServer")',
  '  (global-name "com.apple.fonts")',
  '  (global-name "com.apple.logd")',
  '  (global-name "com.apple.lsd.mapdb")',
  '  (global-name "com.apple.PowerManagement.control")',
  '  (global-name "com.apple.system.logger")',
  '  (global-name "com.apple.system.notification_center")',
  '  (global-name "com.apple.system.opendirectoryd.libinfo")',
  '  (global-name "com.apple.system.opendirectoryd.membership")',
  '  (global-name "com.apple.bsd.dirhelper")',
  '  (global-name "com.apple.securityd.xpc")',
  '  (global-name "com.apple.coreservices.launchservicesd")',
  ')',
  '(allow ipc-posix-shm)',
  '(allow ipc-posix-sem)',
  '(allow iokit-open',
  '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
  '  (iokit-registry-entry-class "RootDomainUserClient")',
  '  (iokit-user-client-class "IOSurfaceSendRight")',
  ')',
  '(allow iokit-get-properties)',
  '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
  '(allow sysctl-read',
  '  (sysctl-name "hw.activecpu")',
  '  (sysctl-name "hw.busfrequency_compat")',
  '  (sysctl-name "hw.byteorder")',
  '  (sysctl-name "hw.cacheconfig")',
  '  (sysctl-name "hw.cachelinesize_compat")',
  '  (sysctl-name "hw.cpufamily")',
  '  (sysctl-name "hw.cpufrequency")',
  '  (sysctl-name "hw.cpufrequency_compat")',
  '  (sysctl-name "hw.cputype")',
  '  (sysctl-name "hw.l1dcachesize_compat")',
  '  (sysctl-name "hw.l1icachesize_compat")',
  '  (sysctl-name "hw.l2cachesize_compat")',
  '  (sysctl-name "hw.l3cachesize_compat")',
  '  (sysctl-name "hw.logicalcpu")',
  '  (sysctl-name "hw.logicalcpu_max")',
  '  (sysctl-name "hw.machine")',
  '  (sysctl-name "hw.memsize")',
  '  (sysctl-name "hw.ncpu")',
  '  (sysctl-name "hw.nperflevels")',
  '  (sysctl-name "hw.packages")',
  '  (sysctl-name "hw.pagesize_compat")',
  '  (sysctl-name "hw.pagesize")',
  '  (sysctl-name "hw.physicalcpu")',
  '  (sysctl-name "hw.physicalcpu_max")',
  '  (sysctl-name "hw.tbfrequency_compat")',
  '  (sysctl-name "hw.vectorunit")',
  '  (sysctl-name "kern.argmax")',
  '  (sysctl-name "kern.bootargs")',
  '  (sysctl-name "kern.hostname")',
  '  (sysctl-name "kern.maxfiles")',
  '  (sysctl-name "kern.maxfilesperproc")',
  '  (sysctl-name "kern.maxproc")',
  '  (sysctl-name "kern.ngroups")',
  '  (sysctl-name "kern.osproductversion")',
  '  (sysctl-name "kern.osrelease")',
  '  (sysctl-name "kern.ostype")',
  '  (sysctl-name "kern.osvariant_status")',
  '  (sysctl-name "kern.osversion")',
  '  (sysctl-name "kern.secure_kernel")',
  '  (sysctl-name "kern.tcsm_available")',
  '  (sysctl-name "kern.tcsm_enable")',
  '  (sysctl-name "kern.usrstack64")',
  '  (sysctl-name "kern.version")',
  '  (sysctl-name "kern.willshutdown")',
  '  (sysctl-name "machdep.cpu.brand_string")',
  '  (sysctl-name "machdep.ptrauth_enabled")',
  '  (sysctl-name "security.mac.lockdown_mode_state")',
  '  (sysctl-name "sysctl.proc_cputype")',
  '  (sysctl-name "vm.loadavg")',
  '  (sysctl-name-prefix "hw.optional.arm")',
  '  (sysctl-name-prefix "hw.optional.arm.")',
  '  (sysctl-name-prefix "hw.optional.armv8_")',
  '  (sysctl-name-prefix "hw.perflevel")',
  '  (sysctl-name-prefix "kern.proc.all")',
  '  (sysctl-name-prefix "kern.proc.pgrp.")',
  '  (sysctl-name-prefix "kern.proc.pid.")',
  '  (sysctl-name-prefix "machdep.cpu.")',
  '  (sysctl-name-prefix "net.routetable.")',
  ')',
  '(allow sysctl-write',
  '  (sysctl-name "kern.tcsm_enable")',
  ')',
  '(allow distributed-notification-post)',
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
  '(allow mach-lookup (global-name "com.apple.trustd.agent"))',
  '(allow file-ioctl (literal "/dev/null"))',
  '(allow file-ioctl (literal "/dev/zero"))',
  '(allow file-ioctl (literal "/dev/random"))',
  '(allow file-ioctl (literal "/dev/urandom"))',
  '(allow file-ioctl (literal "/dev/dtracehelper"))',
  '(allow file-ioctl (literal "/dev/tty"))',
  '(allow file-ioctl file-read-data file-write-data',
  '  (require-all',
  '    (literal "/dev/null")',
  '    (vnode-type CHARACTER-DEVICE)',
  '  )',
  ')',
]);

const PSEUDO_TERMINAL_RULES: readonly string[] = Object.freeze([
  '(allow pseudo-tty)',
  '(allow file-ioctl',
  '  (literal "/dev/ptmx")',
  '  (regex #"^/dev/ttys")',
  ')',
  '(allow file-read* file-write*',
  '  (literal "/dev/ptmx")',
  '  (regex #"^/dev/ttys")',
  ')',
]);
const DEVICE_WRITE_PATHS: readonly string[] = Object.freeze(['/dev/stdout', '/dev/stderr', '/dev/null', '/dev/tty', '/dev/dtracehelper', '/dev/autofs_nowait']);

const WORKTREE_UNWRITABLE_FILE_NAMES: readonly string[] = Object.freeze(['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.git/config']);

const WORKTREE_UNWRITABLE_FOLDER_NAMES: readonly string[] = Object.freeze(['.vscode', '.idea', '.claude/commands', '.claude/agents', '.git/hooks']);

interface SeatbeltPolicy {
  denyRead: readonly string[];
  allowRead: readonly string[];
  readableLinks: readonly string[];
  allowWrite: readonly string[];
  denyWrite: readonly string[];
  worktree: string;
  loopbackPorts: readonly number[];
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

function subpath(folder: string): string {
  return `(subpath ${quoted(folder)})`;
}

function literal(filePath: string): string {
  return `(literal ${quoted(filePath)})`;
}

function rule(action: 'allow' | 'deny', operations: string, filters: readonly string[]): string[] {
  const uniqueFilters = [...new Set(filters)];
  if (uniqueFilters.length === 0) return [];
  return [`(${action} ${operations}`, ...uniqueFilters.map((filter) => `  ${filter}`), ')'];
}

function ancestorsOf(entryPath: string): string[] {
  const parent = path.dirname(entryPath);
  if (parent === entryPath || parent === '/') return [];
  return [parent, ...ancestorsOf(parent)];
}

function escapedForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function caseInsensitivePattern(name: string): string {
  return escapedForRegex(name).replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
}

function alternationOf(names: readonly string[]): string {
  return names.map(caseInsensitivePattern).join('|');
}

function worktreeUnwritableRegexes(worktree: string): string[] {
  const anchor = `^${escapedForRegex(worktree)}/(.*/)?`;
  return [`(regex ${quoted(`${anchor}(${alternationOf(WORKTREE_UNWRITABLE_FILE_NAMES)})$`)})`, `(regex ${quoted(`${anchor}(${alternationOf(WORKTREE_UNWRITABLE_FOLDER_NAMES)})(/.*)?$`)})`];
}

function worktreeUnwritableParentRegex(worktree: string): string {
  const parentNames = [...new Set([...WORKTREE_UNWRITABLE_FILE_NAMES, ...WORKTREE_UNWRITABLE_FOLDER_NAMES].filter((name) => name.includes('/')).map((name) => name.split('/')[0]))];
  return `(regex ${quoted(`^${escapedForRegex(worktree)}/(${alternationOf(parentNames)})$`)})`;
}

function isStrictlyInsideAny(folders: readonly string[], entryPath: string): boolean {
  return folders.some((folder) => isPathInside(folder, entryPath, { allowEqual: false }));
}

function moveBlockingFilters(entryPaths: readonly string[]): string[] {
  return entryPaths.flatMap((entryPath) => [subpath(entryPath), ...ancestorsOf(entryPath).map(literal)]);
}

function deniedReadsInsideReadableFolders(policy: SeatbeltPolicy): string[] {
  return policy.denyRead.filter((denied) => isStrictlyInsideAny(policy.allowRead, denied));
}

function readRules(policy: SeatbeltPolicy): string[] {
  return [
    '(allow file-read*)',
    ...rule('deny', 'file-read*', policy.denyRead.map(subpath)),
    ...rule('allow', 'file-read*', [...policy.allowRead.map(subpath), ...policy.readableLinks.map(literal)]),
    ...rule('deny', 'file-read*', deniedReadsInsideReadableFolders(policy).map(subpath)),
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    ...rule('deny', 'file-write-unlink file-write-create', moveBlockingFilters(policy.denyRead)),
    ...rule('allow', 'file-write-unlink file-write-create', policy.allowWrite.map(subpath)),
  ];
}

function writeRules(policy: SeatbeltPolicy): string[] {
  const denyReadInsideWriteRoots = policy.denyRead.filter((denied) => isStrictlyInsideAny(policy.allowWrite, denied));
  const worktreeRegexes = worktreeUnwritableRegexes(policy.worktree);
  const deniedWrites = [...policy.denyWrite, ...denyReadInsideWriteRoots];
  return [
    ...rule('allow', 'file-write*', [...policy.allowWrite.map(subpath), ...DEVICE_WRITE_PATHS.map(literal)]),
    ...rule('deny', 'file-write*', [...deniedWrites.map(subpath), ...worktreeRegexes]),
    ...rule('deny', 'file-write-unlink file-write-create', [...moveBlockingFilters(deniedWrites), ...worktreeRegexes, worktreeUnwritableParentRegex(policy.worktree), ...[policy.worktree, ...ancestorsOf(policy.worktree)].map(literal)]),
  ];
}

function unixSocketRules(policy: SeatbeltPolicy): string[] {
  const socketsUnder = (folders: readonly string[]) => folders.map((folder) => `(remote unix-socket ${subpath(folder)})`);
  return [
    '(allow system-socket (socket-domain AF_UNIX))',
    '(allow network-bind (local unix-socket (path-regex #"^/")))',
    '(allow network-outbound (remote unix-socket (path-regex #"^/")))',
    ...rule('deny', 'network-outbound', socketsUnder(policy.denyRead)),
    ...rule('allow', 'network-outbound', socketsUnder(policy.allowRead)),
    ...rule('deny', 'network-outbound', socketsUnder(deniedReadsInsideReadableFolders(policy))),
  ];
}

function loopbackRules(loopbackPorts: readonly number[]): string[] {
  const validPorts = [...new Set(loopbackPorts)].filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return rule('allow', 'network-outbound', validPorts.map((port) => `(remote ip ${quoted(`localhost:${port}`)})`));
}

function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  return [
    '(version 1)',
    '(deny default)',
    ...SRT_MACOS_BASELINE_RULES,
    ...loopbackRules(policy.loopbackPorts),
    ...unixSocketRules(policy),
    ...readRules(policy),
    ...writeRules(policy),
    ...PSEUDO_TERMINAL_RULES,
  ].join('\n');
}

export { buildSeatbeltProfile };

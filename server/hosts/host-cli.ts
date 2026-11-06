import { HostEntries } from '../../shared/contracts/hosts.ts';
import type { HostEntry } from '../../shared/contracts/hosts.ts';
import { errorMessage } from '../../shared/text.ts';
import { renderTable } from '../core/ascii-figure-core.ts';
import type { ParsedCommand } from '../core/cli-spec-core.ts';
import { addHostTo, removeHostFrom } from './core/host-registry-core.ts';
import type { HostRegistryChange } from './core/host-registry-core.ts';
import { processIo, requireView, saveValidatedConfig } from '../settings-cli.ts';
import type { SettingsCliIo } from '../settings-cli.ts';

const DEFAULT_DASHBOARD_PORT = 3000;

type ParsedHostRun = Extract<ParsedCommand, { kind: 'run' }>;
type HostCommand = (parsed: ParsedHostRun, io: SettingsCliIo) => number;

function registeredHosts(): HostEntry[] {
  const parsed = HostEntries.safeParse(requireView().config.hosts ?? []);
  if (!parsed.success) throw new Error('hosts in config.json is not valid; fix it with glimmervoid settings');
  return parsed.data;
}

function saveHostChange(change: (hosts: readonly HostEntry[]) => HostRegistryChange): void {
  saveValidatedConfig(requireView(), 'hosts', (config) => {
    const changed = change(HostEntries.parse(config.hosts ?? []));
    if (!changed.ok) throw new Error(changed.error);
    if (changed.hosts.length === 0) delete config.hosts;
    if (changed.hosts.length > 0) config.hosts = changed.hosts;
  });
}

function dashboardPortOf(raw: string | boolean | undefined): number {
  if (typeof raw !== 'string') return DEFAULT_DASHBOARD_PORT;
  if (!/^\d+$/.test(raw)) throw new Error(`--port ${raw} is not a port number`);
  return Number(raw);
}

function hostLines(hosts: readonly HostEntry[]): string {
  if (hosts.length === 0) return 'No hosts registered. Add one with glimmervoid host add <id> --ssh <target>.';
  return renderTable({
    title: 'Hosts',
    headers: ['Id', 'Name', 'Ssh target', 'Dashboard port'],
    rows: hosts.map((host) => [host.id, host.name, host.sshTarget, String(host.dashboardPort)]),
    align: ['left', 'left', 'left', 'right'],
  });
}

const RELOAD_NOTE = 'A running Glimmervoid picks this up without a restart.';

const HOST_COMMANDS: Readonly<Record<string, HostCommand>> = {
  add: ({ positionals, values }, io) => {
    const hostId = positionals[0] ?? '';
    if (typeof values.ssh !== 'string') throw new Error('add needs --ssh <target>, such as glimmervoid host add devbox --ssh devbox');
    const candidate = {
      id: hostId,
      name: typeof values.name === 'string' ? values.name : hostId,
      sshTarget: values.ssh,
      dashboardPort: dashboardPortOf(values.port),
    };
    saveHostChange((hosts) => addHostTo(hosts, candidate));
    io.writeOutput(`Added host ${hostId} (${candidate.sshTarget}, dashboard port ${candidate.dashboardPort}). ${RELOAD_NOTE}\n`);
    return 0;
  },
  list: ({ values }, io) => {
    const hosts = registeredHosts();
    io.writeOutput(`${values.json === true ? JSON.stringify(hosts, null, 2) : hostLines(hosts)}\n`);
    return 0;
  },
  remove: ({ positionals }, io) => {
    const hostId = positionals[0] ?? '';
    saveHostChange((hosts) => removeHostFrom(hosts, hostId));
    io.writeOutput(`Removed host ${hostId}; its sessions keep running there. ${RELOAD_NOTE}\n`);
    return 0;
  },
};

export function runHostCli(parsed: ParsedHostRun, io: SettingsCliIo = processIo()): number {
  const commandName = parsed.commandPath[1] ?? '';
  const command = HOST_COMMANDS[commandName];
  if (!command) {
    io.writeError(`host: unknown command ${commandName}\n`);
    return 1;
  }
  try {
    return command(parsed, io);
  } catch (error) {
    io.writeError(`host: ${errorMessage(error)}\n`);
    return 1;
  }
}

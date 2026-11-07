import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { decideInboxBind } from './core/job-inbox-core.ts';
import type { InboxBindDecision } from './core/job-inbox-core.ts';
import { createJobInboxRequestHandler } from './job-inbox-listener.ts';
import type { WatcherJobHandlers } from './job-inbox-listener.ts';
import { watcherChildInboxUrl } from '../watcher/core/watcher-core.ts';
import { createWatcherSupervisor } from '../watcher/watcher-supervisor.ts';
import type { Config } from '../../shared/contracts/config.ts';

interface JobInbox {
  decision: InboxBindDecision;
  token: string | null;
  attach(inboxServer: Server): void;
  startWatcher(boundInboxPort: number): void;
  refreshWatcherEnvironment(): void;
}

const NO_OP_INBOX = { attach: () => {}, startWatcher: () => {}, refreshWatcherEnvironment: () => {} };

function createJobInbox({ watcherConfig, handlers, watcherEnvironment, log = console }: {
  watcherConfig: Config['watcher'];
  handlers: WatcherJobHandlers;
  watcherEnvironment?: () => Record<string, string>;
  log?: Pick<Console, 'log' | 'warn'>;
}): JobInbox {
  const envToken = watcherConfig?.token ?? null;
  const isAutoStarting = watcherConfig?.autoStart !== false;
  const decision = decideInboxBind({
    autoStart: isAutoStarting,
    inboxHost: watcherConfig?.inboxHost ?? null,
    inboxPort: watcherConfig?.inboxPort ?? null,
    envToken,
  });
  if (!decision.listen) {
    if (decision.reason !== null) log.warn(`[job-inbox] ${decision.reason}; the job inbox is off`);
    return { decision, token: null, ...NO_OP_INBOX };
  }
  const token = decision.tokenSource === 'env' && envToken !== null ? envToken : crypto.randomBytes(32).toString('hex');
  const handleRequest = createJobInboxRequestHandler({ token, handlers, log });
  const stopCallbacks: (() => void)[] = [];
  const environmentRefreshes: (() => void)[] = [];
  return {
    decision,
    token,
    attach(inboxServer) {
      inboxServer.on('request', handleRequest);
      inboxServer.once('close', () => { for (const stopWatcher of stopCallbacks) stopWatcher(); });
    },
    startWatcher(boundInboxPort) {
      if (!isAutoStarting) return;
      const inboxUrl = watcherChildInboxUrl(decision.host, boundInboxPort);
      if (inboxUrl === null) {
        log.warn(`[watcher] not started: watcher.inboxHost ${decision.host} is neither this machine nor every interface, so the local watcher cannot reach it over http`);
        return;
      }
      const supervisor = createWatcherSupervisor({ inboxUrl, token, environment: watcherEnvironment, log });
      stopCallbacks.push(supervisor.stop);
      environmentRefreshes.push(supervisor.refreshEnvironment);
      supervisor.start();
    },
    refreshWatcherEnvironment() {
      for (const refresh of environmentRefreshes) refresh();
    },
  };
}

export { createJobInbox };

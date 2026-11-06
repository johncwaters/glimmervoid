import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { decideInboxBind } from './core/job-inbox-core.ts';
import type { InboxBindDecision } from './core/job-inbox-core.ts';
import { createJobInboxRequestHandler } from './job-inbox-listener.ts';
import type { Config } from '../../shared/contracts/config.ts';

interface JobInbox {
  decision: InboxBindDecision;
  token: string | null;
  attach(inboxServer: Server): void;
}

function createJobInbox({ watcherConfig, log = console }: {
  watcherConfig: Config['watcher'];
  log?: Pick<Console, 'warn'>;
}): JobInbox {
  const envToken = watcherConfig?.token ?? null;
  const decision = decideInboxBind({
    autoStart: watcherConfig?.autoStart !== false,
    inboxHost: watcherConfig?.inboxHost ?? null,
    inboxPort: watcherConfig?.inboxPort ?? null,
    envToken,
  });
  if (!decision.listen) {
    if (decision.reason !== null) log.warn(`[job-inbox] ${decision.reason}; the job inbox is off`);
    return { decision, token: null, attach: () => {} };
  }
  const token = decision.tokenSource === 'env' && envToken !== null ? envToken : crypto.randomBytes(32).toString('hex');
  const handleRequest = createJobInboxRequestHandler({ token, log });
  return {
    decision,
    token,
    attach(inboxServer) {
      inboxServer.on('request', handleRequest);
    },
  };
}

export { createJobInbox };

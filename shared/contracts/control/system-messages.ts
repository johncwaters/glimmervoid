import { z } from 'zod';
import { UpdateJournal } from '../update-journal.ts';
import { FeatureHint } from '../feature-hints.ts';
import { HostStatus } from '../hosts.ts';
import { requestId, sessionId, loose, opaqueObject, updateStatusShape, ClientErrorReport, ClientLogReport, DASHBOARD_TELEMETRY_EVENTS } from './control-fields.ts';

export const systemClientVariants = [
  loose('ping', { requestId }),
  loose('shutdown'),
  loose('restart-server'),
  loose('alert-seen', { id: sessionId }),
  loose('terminal-colors', { background: z.string().regex(/^#[0-9a-fA-F]{6}$/), foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
  loose('request-health-snapshot'),
  loose('request-telemetry-deletion', { requestId }),
  loose('update-check'),
  loose('update-apply'),
  loose('client-error', ClientErrorReport.shape),
  loose('client-log', ClientLogReport.shape),
  loose('dashboard-telemetry', { event: z.enum(DASHBOARD_TELEMETRY_EVENTS), properties: z.record(z.string(), z.unknown()) }),
] as const;

export const systemServerVariants = [
  loose('update-status', updateStatusShape),
  loose('update-progress', { journal: UpdateJournal }),
  loose('pong', { requestId }),
  loose('health-snapshot', { stats: opaqueObject }),
  loose('telemetry-deletion-result', { requestId, ok: z.boolean() }),
  loose('client-trust', { trust: z.enum(['local', 'remote']) }),
  loose('shutting-down'),
  loose('restarting'),
  loose('feature-hint', { hint: FeatureHint }),
  loose('star-hint'),
  loose('hosts-status', { hosts: z.array(HostStatus) }),
] as const;

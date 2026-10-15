import { z } from 'zod';
import { decideTelemetryConsent, nodeMajorVersion } from '../../server/core/telemetry-core.ts';
import type { TelemetryConfig } from '../../server/core/telemetry-core.ts';
import { InstallFlavor } from '../../shared/contracts/control-messages.ts';
import { intents } from './intents.ts';
import { failurePrecedence } from './verdict.ts';
import type { Verdict } from './verdict.ts';

export const HarnessInstallState = z.object({ installId: z.uuid(), remoteDisabled: z.boolean().optional() }).strict();

export function parseHarnessInstallState(document: unknown) {
  const parsed = HarnessInstallState.safeParse(document);
  return parsed.success ? parsed.data : null;
}

export const FactoryHarnessRunProperties = z.object({
  intent: z.enum(['custom', ...intents.map((intent) => intent.name)]),
  expected_end: z.enum(['completed', 'refused']),
  outcome: z.enum(['pass', 'partial', 'fail']),
  failure_class: z.enum(failurePrecedence).nullable(),
  duration_ms: z.number().int().nonnegative(),
  session_count: z.number().int().nonnegative(),
  order_count: z.number().int().nonnegative(),
  max_attempt: z.number().int().nonnegative().nullable(),
  spend_usd: z.number().nonnegative().nullable(),
  run_index: z.number().int().positive(),
  batch_size: z.number().int().positive(),
}).strict();

export interface RunTelemetryContext {
  isCustomIntent: boolean;
  runIndex: number;
  batchSize: number;
}

export type TelemetrySendResult = 'sent' | 'failed' | 'skipped-no-consent' | 'skipped-remote-disabled';
export type RecordedVerdict = Verdict & { telemetrySendResult: TelemetrySendResult };

export function buildRunTelemetryProperties(verdict: Verdict, context: RunTelemetryContext) {
  const attempts = Object.values(verdict.attemptsPerOrder);
  return FactoryHarnessRunProperties.parse({
    intent: context.isCustomIntent ? 'custom' : verdict.intentName,
    expected_end: verdict.expectedEnd,
    outcome: verdict.outcome,
    failure_class: verdict.failureClass,
    duration_ms: verdict.durationMs,
    session_count: verdict.sessionCount,
    order_count: verdict.orderCount,
    max_attempt: attempts.length > 0 ? Math.max(...attempts) : null,
    spend_usd: verdict.spendUsd,
    run_index: context.runIndex,
    batch_size: context.batchSize,
  });
}

export const FactoryHarnessBaseProperties = z.object({
  app_version: z.string().min(1),
  os_platform: z.enum(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd']),
  node_major: z.number().int().positive(),
  install_flavor: InstallFlavor,
  is_bundled: z.boolean(),
  is_dev_install: z.literal(true),
}).strict();

export const FactoryHarnessBatch = z.object({
  api_key: z.string().min(1),
  batch: z.tuple([z.object({
    event: z.literal('factory_harness_run'),
    distinct_id: z.uuid(),
    timestamp: z.iso.datetime(),
    properties: FactoryHarnessRunProperties.extend({
      ...FactoryHarnessBaseProperties.shape,
      $lib: z.literal('glimmervoid'),
      $process_person_profile: z.literal(false),
    }).strict(),
  }).strict()]),
}).strict();

export function buildRunTelemetryBatch(verdict: Verdict, context: RunTelemetryContext, installation: {
  installId: string;
  projectToken: string;
  appVersion: string;
  platform: string;
  nodeVersion: string;
  installFlavor: InstallFlavor;
  isBundled: boolean;
  timestamp: string;
}) {
  return FactoryHarnessBatch.parse({
    api_key: installation.projectToken,
    batch: [{
      event: 'factory_harness_run',
      distinct_id: installation.installId,
      timestamp: installation.timestamp,
      properties: {
        ...buildRunTelemetryProperties(verdict, context),
        $lib: 'glimmervoid',
        $process_person_profile: false,
        app_version: installation.appVersion,
        os_platform: installation.platform,
        node_major: nodeMajorVersion(installation.nodeVersion),
        install_flavor: installation.installFlavor,
        is_bundled: installation.isBundled,
        is_dev_install: true,
      },
    }],
  });
}

export interface HarnessTelemetryInputs {
  environment: NodeJS.ProcessEnv;
  noTelemetry: boolean;
  operatorConfig: TelemetryConfig;
  installId: string | null;
  isRemoteDisabled: boolean;
}

export interface RunHomeTelemetrySeed {
  installId: string;
  remoteDisabled: boolean;
}

export type HarnessTelemetryDecision =
  | { summary: 'send'; installId: string; runHomeSeed: RunHomeTelemetrySeed; childEnvironment: NodeJS.ProcessEnv }
  | { summary: Exclude<TelemetrySendResult, 'sent'>; runHomeSeed: RunHomeTelemetrySeed | null; childEnvironment: NodeJS.ProcessEnv };

export function decideHarnessTelemetry({ environment, noTelemetry, operatorConfig, installId, isRemoteDisabled }: HarnessTelemetryInputs): HarnessTelemetryDecision {
  const environmentWithTelemetryOff = { ...environment, GLIMMERVOID_TELEMETRY: '0' };
  const consentEnvironment = noTelemetry ? environmentWithTelemetryOff : environment;
  if (!decideTelemetryConsent(consentEnvironment, operatorConfig).isEnabled) return { summary: 'skipped-no-consent', runHomeSeed: null, childEnvironment: environmentWithTelemetryOff };
  if (installId === null) return { summary: 'failed', runHomeSeed: null, childEnvironment: environmentWithTelemetryOff };
  const runHomeSeed = { installId, remoteDisabled: isRemoteDisabled };
  if (isRemoteDisabled) return { summary: 'skipped-remote-disabled', runHomeSeed, childEnvironment: environment };
  return { summary: 'send', installId, runHomeSeed, childEnvironment: environment };
}

export function withoutTelemetryConfig(document: unknown): Record<string, unknown> & { telemetry?: never } {
  const { telemetry: _telemetry, ...runConfig } = z.record(z.string(), z.unknown()).parse(document);
  return runConfig;
}

import { isRecord } from '../../../shared/coerce.ts';
import { VerificationSettings } from '../../../shared/contracts/verification.ts';
import type { CheckOutcome } from '../../../shared/contracts/verification.ts';

const SHELL_METACHARACTERS = /[;&|<>$`'"\\*?(){}[\]~%^!\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const SECRET_LINE_PATTERN = /(api[_-]?key|secret|token|password|passwd|authorization|bearer)\s*[:=]/i;

type VerificationSettingsLookup =
  | { kind: 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; settings: VerificationSettings };

export function parseCheckCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed.replace(/[\t\r\n]/g, ' '))) return null;
  return trimmed.split(/\s+/);
}

export function launchArgvFor(argv: readonly string[], platform: string, commandShell: string): { program: string; args: string[] } {
  if (platform !== 'win32') return { program: argv[0], args: argv.slice(1) };
  return { program: commandShell, args: ['/d', '/s', '/c', argv.join(' ')] };
}

export function redactSecretLines(text: string, secretValues: readonly string[]): string {
  const secrets = secretValues.filter((secret) => secret.length >= 6);
  return text
    .split('\n')
    .map((line) => (SECRET_LINE_PATTERN.test(line) || secrets.some((secret) => line.includes(secret)) ? '[redacted]' : line))
    .join('\n');
}

export function overallStatus(outcomes: readonly CheckOutcome[]): 'passed' | 'failed' {
  return outcomes.every((outcome) => outcome.status === 'pass') ? 'passed' : 'failed';
}

export function settingsFingerprint(settings: VerificationSettings): string {
  return JSON.stringify([settings.timeoutSeconds, settings.checks.map((check) => [check.id, check.command])]);
}

export function readVerificationSettings(verificationConfig: unknown, repoPath: string): VerificationSettingsLookup {
  if (!isRecord(verificationConfig) || !isRecord(verificationConfig.repos)) return { kind: 'none' };
  const entry = verificationConfig.repos[repoPath];
  if (entry === undefined) return { kind: 'none' };
  const parsed = VerificationSettings.safeParse(entry);
  if (!parsed.success) return { kind: 'invalid', message: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`).join('; ') };
  if (parsed.data.checks.length === 0) return { kind: 'none' };
  return { kind: 'ok', settings: parsed.data };
}

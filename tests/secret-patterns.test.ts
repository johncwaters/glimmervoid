import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecretRange } from '../shared/secret-patterns.ts';
import { findSecretRanges } from '../shared/secret-patterns.ts';

const ANTHROPIC_KEY = `sk-ant-api03-${'a1B2'.repeat(6)}`;
const OPENAI_KEY = `sk-proj-${'Zx9'.repeat(8)}`;
const POSTHOG_PROJECT_KEY = `phc_${'Qw3'.repeat(14)}`;
const POSTHOG_PERSONAL_KEY = `phx_${'Er4'.repeat(14)}`;
const PEM_BODY_LINE = `MIIEvQIBADANBgkqhkiG9w0BAQEFAASC${'Kc9w'.repeat(8)}`;
const PEM_LAST_FULL_LINE = `${'AbC+/9'.repeat(10)}xY==`;
const SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const RANGE_CASES: [string, string, string[]][] = [
  ['anthropic key in prose', `using ${ANTHROPIC_KEY} now`, [ANTHROPIC_KEY]],
  ['openai key in prose', `key is ${OPENAI_KEY}`, [OPENAI_KEY]],
  ['posthog project key', `init(${POSTHOG_PROJECT_KEY})`, [POSTHOG_PROJECT_KEY]],
  ['posthog personal key', `curl -H "X: ${POSTHOG_PERSONAL_KEY}"`, [POSTHOG_PERSONAL_KEY]],
  ['env line masks only the value', 'GLIMMERVOID_TELEGRAM_BOT_TOKEN=123:abcDEF', ['123:abcDEF']],
  ['env line with a KEY name', 'STRIPE_KEY=rk_live_abc123', ['rk_live_abc123']],
  ['env line carrying a known shape keeps one range', `export ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, [ANTHROPIC_KEY]],
  ['each env line of a chunk', 'PASSWORD=hunter2\nbuilding\nCLIENT_SECRET=s3cr3t', ['hunter2', 's3cr3t']],
  ['url credentials the env name misses', 'DATABASE_URL=postgres://app:S3cretPw@db/x', ['S3cretPw']],
  ['url credentials in a command', 'psql postgres://app:S3cretPw@db/x', ['S3cretPw']],
  ['password flag value', 'tool --password hunter2 --verbose', ['hunter2']],
  ['curl user password', 'curl -u admin:s3cret https://example.test', ['s3cret']],
  ['mysql attached password', 'mysql -uroot -pS3cret appdb', ['S3cret']],
  ['basic authorization header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', ['dXNlcjpwYXNzd29yZA==']],
  ['pem body line in a terminal row', `${PEM_BODY_LINE}      `, [PEM_BODY_LINE]],
  ['pem end line', '-----END RSA PRIVATE KEY-----', ['-----END RSA PRIVATE KEY-----']],
  [
    'whole pem block in one text node',
    `-----BEGIN PRIVATE KEY-----\n${PEM_BODY_LINE}\r\n${PEM_LAST_FULL_LINE}\n-----END PRIVATE KEY-----`,
    ['-----BEGIN PRIVATE KEY-----', PEM_BODY_LINE, PEM_LAST_FULL_LINE, '-----END PRIVATE KEY-----'],
  ],
  ['a lone sha256 hash stays visible', SHA256_HEX, []],
  ['a lone git sha stays visible', 'f95969cd1234567890abcdef1234567890abcdef', []],
];

function maskedSlices(text: string, ranges: SecretRange[]): string[] {
  return ranges.map((range) => text.slice(range.start, range.end));
}

test('findSecretRanges covers each token shape, command credential, pem line and env-line value', () => {
  for (const [name, text, expectedSecrets] of RANGE_CASES) {
    assert.deepEqual(maskedSlices(text, findSecretRanges(text)), expectedSecrets, name);
  }
});

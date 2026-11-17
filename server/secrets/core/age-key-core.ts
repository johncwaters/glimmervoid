import { SecretName } from '../../../shared/contracts/secrets.ts';

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const AGE_RECIPIENT_PREFIX = 'age';
const AGE_SECRET_KEY_PREFIX = 'age-secret-key-';
const AGE_PROVIDER_NAME = 'source';
const X25519_KEY_LENGTH = 32;
const PUBLIC_KEY_COMMENT = '# public key: ';

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    BECH32_GENERATORS.forEach((generator, bit) => {
      if ((top >>> bit) & 1) checksum ^= generator;
    });
  }
  return checksum;
}

function fiveBitWordsOf(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) & 0xffff;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      words.push((accumulator >>> bitCount) & 31);
    }
  }
  if (bitCount > 0) words.push((accumulator << (5 - bitCount)) & 31);
  return words;
}

function bech32Encode(humanPart: string, bytes: Uint8Array): string {
  const words = fiveBitWordsOf(bytes);
  const expandedHumanPart = [...[...humanPart].map((character) => character.charCodeAt(0) >>> 5), 0, ...[...humanPart].map((character) => character.charCodeAt(0) & 31)];
  const polymod = bech32Polymod([...expandedHumanPart, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksumWords = [0, 1, 2, 3, 4, 5].map((index) => (polymod >>> (5 * (5 - index))) & 31);
  return `${humanPart}1${[...words, ...checksumWords].map((word) => BECH32_CHARSET[word]).join('')}`;
}

function requireKeyLength(key: Uint8Array): void {
  if (key.length !== X25519_KEY_LENGTH) throw new RangeError(`an X25519 key is ${X25519_KEY_LENGTH} bytes, got ${key.length}`);
}

function ageRecipientOf(publicKey: Uint8Array): string {
  requireKeyLength(publicKey);
  return bech32Encode(AGE_RECIPIENT_PREFIX, publicKey);
}

function ageIdentityFileText(privateKey: Uint8Array, publicKey: Uint8Array): string {
  requireKeyLength(privateKey);
  return `${PUBLIC_KEY_COMMENT}${ageRecipientOf(publicKey)}\n${bech32Encode(AGE_SECRET_KEY_PREFIX, privateKey).toUpperCase()}\n`;
}

function recipientInIdentityFile(identityText: string): string | null {
  const commentLine = identityText.split(/\r?\n/).find((line) => line.startsWith(PUBLIC_KEY_COMMENT));
  if (commentLine === undefined) return null;
  const recipient = commentLine.slice(PUBLIC_KEY_COMMENT.length).trim();
  return /^age1[02-9ac-hj-np-z]{58}$/.test(recipient) ? recipient : null;
}

function ageStoreConfigText(recipient: string): string {
  return `[providers.${AGE_PROVIDER_NAME}]\ntype = "age"\nrecipients = [${JSON.stringify(recipient)}]\n`;
}

function storedNamesOf(storeText: string): string[] {
  const names: string[] = [];
  let isInSecretsTable = false;
  for (const rawLine of storeText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const secretTableName = /^\[secrets\.([A-Za-z0-9_]+)\]$/.exec(line)?.[1];
    if (secretTableName !== undefined && SecretName.safeParse(secretTableName).success) names.push(secretTableName);
    if (line.startsWith('[')) {
      isInSecretsTable = line === '[secrets]';
      continue;
    }
    if (!isInSecretsTable) continue;
    const candidate = /^([A-Za-z0-9_]+)\s*=/.exec(line)?.[1];
    if (candidate !== undefined && SecretName.safeParse(candidate).success) names.push(candidate);
  }
  return names.sort();
}

export { ageIdentityFileText, ageStoreConfigText, recipientInIdentityFile, storedNamesOf };

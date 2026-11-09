import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeTextAtomicSync } from '../../server/json-file.ts';
import { errorLabel } from '../../shared/text.ts';

const LINK_SECRET_BYTES = 32;
const LINK_SECRET_PATTERN = /^[0-9a-f]{64}$/;

function storedLinkSecret(filePath: string): Buffer | null {
  try {
    const secretHex = fs.readFileSync(filePath, 'utf8').trim();
    return LINK_SECRET_PATTERN.test(secretHex) ? Buffer.from(secretHex, 'hex') : null;
  } catch {
    return null;
  }
}

function storeLinkSecret(filePath: string, secret: Buffer): void {
  writeTextAtomicSync(filePath, `${secret.toString('hex')}\n`, { mode: 0o600, mkdir: true, enforceMode: true });
}

function adoptLegacyLinkSecret(filePath: string, legacyFilePath: string, legacySecret: Buffer): Buffer {
  try {
    storeLinkSecret(filePath, legacySecret);
    fs.rmSync(legacyFilePath, { force: true });
  } catch (error) {
    console.warn(`[watcher-link] could not move ${legacyFilePath} to ${filePath}, so the key stays where it was: ${errorLabel(error)}`);
  }
  return legacySecret;
}

function loadOrCreateLinkSecret(filePath: string, legacyFilePath: string | null = null): Buffer {
  const existingSecret = storedLinkSecret(filePath);
  if (existingSecret !== null) return existingSecret;
  const legacySecret = legacyFilePath === null ? null : storedLinkSecret(legacyFilePath);
  if (legacyFilePath !== null && legacySecret !== null) return adoptLegacyLinkSecret(filePath, legacyFilePath, legacySecret);
  const freshSecret = crypto.randomBytes(LINK_SECRET_BYTES);
  storeLinkSecret(filePath, freshSecret);
  return freshSecret;
}

export { loadOrCreateLinkSecret };

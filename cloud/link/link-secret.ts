import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeTextAtomicSync } from '../../server/json-file.ts';

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

function loadOrCreateLinkSecret(filePath: string): Buffer {
  const existingSecret = storedLinkSecret(filePath);
  if (existingSecret !== null) return existingSecret;
  const freshSecret = crypto.randomBytes(LINK_SECRET_BYTES);
  writeTextAtomicSync(filePath, `${freshSecret.toString('hex')}\n`, { mode: 0o600, mkdir: true, enforceMode: true });
  return freshSecret;
}

export { loadOrCreateLinkSecret };

import crypto from 'node:crypto';

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function sealBytes(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
}

function openSealed(key: Buffer, stored: Buffer): Buffer | null {
  if (stored.length <= IV_BYTES + AUTH_TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, stored.subarray(0, IV_BYTES));
    decipher.setAuthTag(stored.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES));
    return Buffer.concat([decipher.update(stored.subarray(IV_BYTES + AUTH_TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

export { openSealed, sealBytes };

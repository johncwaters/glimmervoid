import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ageIdentityFileText, ageStoreConfigText, recipientInIdentityFile, storedNamesOf } from './core/age-key-core.ts';
import { ageStorePaths } from './core/secret-files-core.ts';
import type { SecretSourceTestResult } from '../../shared/contracts/secrets.ts';

const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface AgeStore {
  storePath: string;
  keyPath: string;
  ensureCreated(): Promise<void>;
  storedNames(): Promise<string[]>;
  test(): Promise<SecretSourceTestResult>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isExistingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function writeNewPrivateFile(filePath: string, text: string): Promise<void> {
  try {
    await fs.writeFile(filePath, text, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
  } catch (error) {
    if (!isExistingFile(error)) throw error;
  }
}

function rawKeyBytes(base64UrlKey: string | undefined): Uint8Array {
  if (base64UrlKey === undefined) throw new Error('node:crypto returned an X25519 key without its raw bytes');
  return Buffer.from(base64UrlKey, 'base64url');
}

function newIdentityFileText(): string {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const privateJwk = privateKey.export({ format: 'jwk' });
  return ageIdentityFileText(rawKeyBytes(privateJwk.d), rawKeyBytes(privateJwk.x));
}

function nameCountText(nameCount: number): string {
  return nameCount === 1 ? '1 name' : `${nameCount} names`;
}

function createAgeStore({ glimmervoidHome }: { glimmervoidHome: string }): AgeStore {
  const { storePath, keyPath } = ageStorePaths(glimmervoidHome);

  async function ensureCreated(): Promise<void> {
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: PRIVATE_FOLDER_MODE });
    const [hasKey, hasStore] = await Promise.all([fileExists(keyPath), fileExists(storePath)]);
    if (!hasKey && hasStore) throw new Error(`the age key at ${keyPath} is missing while the age file at ${storePath} still exists; a new key could not read its values, so restore the key or remove the age file`);
    await writeNewPrivateFile(keyPath, newIdentityFileText());
    const recipient = recipientInIdentityFile(await fs.readFile(keyPath, 'utf8'));
    if (recipient === null) throw new Error(`the age key at ${keyPath} has no public key line, so Glimmervoid cannot add values to the age file`);
    await writeNewPrivateFile(storePath, ageStoreConfigText(recipient));
  }

  async function storedNames(): Promise<string[]> {
    const storeText = await readTextOrNull(storePath);
    return storeText === null ? [] : storedNamesOf(storeText);
  }

  async function test(): Promise<SecretSourceTestResult> {
    try {
      return await testFiles();
    } catch (error) {
      return { ok: false, message: 'Glimmervoid could not open the age key or the age file', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async function testFiles(): Promise<SecretSourceTestResult> {
    const [hasKey, nameCount] = await Promise.all([fileExists(keyPath), storedNames().then((names) => names.length)]);
    if (!hasKey && nameCount > 0) return { ok: false, message: `The age key is missing, so the ${nameCountText(nameCount)} in the age file cannot be read`, detail: keyPath };
    if (!hasKey) return { ok: true, message: 'The age file is empty. The first value you save on a request card creates it', detail: '' };
    return { ok: true, message: `The age key is in place and the age file holds ${nameCountText(nameCount)}`, detail: '' };
  }

  return { storePath, keyPath, ensureCreated, storedNames, test };
}

export { createAgeStore };

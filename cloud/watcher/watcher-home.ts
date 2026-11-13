import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProbeSet, WatcherCredentials } from '../../shared/contracts/watcher-link.ts';

const CREDENTIALS_FILENAME = 'credentials.enc';
const PROBE_SET_FILENAME = 'probe-set.json';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;

const NO_CREDENTIALS: WatcherCredentials = Object.freeze({ github: null, posthog: null });

type WatcherFiles = {
  read(fileName: string): Promise<Buffer | null>;
  write(fileName: string, contents: Buffer | string): Promise<void>;
};

async function writePrivately(filePath: string, contents: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_FOLDER_MODE });
  const partialPath = `${filePath}.${process.pid}.partial`;
  await fs.writeFile(partialPath, contents, { mode: PRIVATE_FILE_MODE });
  await fs.rename(partialPath, filePath);
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw readError;
  }
}

function watcherFilesInFolder(homeDir: string): WatcherFiles {
  return {
    read: (fileName) => readOrNull(path.join(homeDir, fileName)),
    write: (fileName, contents) => writePrivately(path.join(homeDir, fileName), contents),
  };
}

function createWatcherHome({ files, credentialKey, log = console }: { files: WatcherFiles; credentialKey: Buffer; log?: Pick<Console, 'warn'> }) {
  async function saveCredentials(credentials: WatcherCredentials): Promise<void> {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey, iv);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    await files.write(CREDENTIALS_FILENAME, Buffer.concat([iv, cipher.getAuthTag(), sealed]));
  }

  async function loadCredentials(): Promise<WatcherCredentials> {
    const stored = await files.read(CREDENTIALS_FILENAME);
    if (stored === null || stored.length <= IV_BYTES + AUTH_TAG_BYTES) return NO_CREDENTIALS;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey, stored.subarray(0, IV_BYTES));
      decipher.setAuthTag(stored.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES));
      const opened = Buffer.concat([decipher.update(stored.subarray(IV_BYTES + AUTH_TAG_BYTES)), decipher.final()]);
      const parsed = WatcherCredentials.safeParse(jsonOrNull(opened.toString('utf8')));
      return parsed.success ? parsed.data : NO_CREDENTIALS;
    } catch {
      log.warn('[watcher] stored credentials were sealed under another link secret; waiting for the server to send them again');
      return NO_CREDENTIALS;
    }
  }

  async function saveProbeSet(probeSet: ProbeSet): Promise<void> {
    await files.write(PROBE_SET_FILENAME, JSON.stringify(probeSet));
  }

  async function loadProbeSet(): Promise<ProbeSet | null> {
    const stored = await files.read(PROBE_SET_FILENAME);
    if (stored === null) return null;
    const parsed = ProbeSet.safeParse(jsonOrNull(stored.toString('utf8')));
    return parsed.success ? parsed.data : null;
  }

  return { saveCredentials, loadCredentials, saveProbeSet, loadProbeSet };
}

type WatcherHome = ReturnType<typeof createWatcherHome>;

export { createWatcherHome, NO_CREDENTIALS, watcherFilesInFolder };
export type { WatcherFiles, WatcherHome };

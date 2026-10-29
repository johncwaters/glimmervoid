import path from 'node:path';
import { UNTRUSTED_PAYLOAD_FILENAME, UntrustedPayload } from '../../shared/contracts/untrusted-payload.ts';
import { writeJsonAtomic } from '../json-file.ts';
import { withoutControlCharacters } from './core/lane-report-core.ts';

function boundedPayload(payload: UntrustedPayload, maxCharsPerItem: number): UntrustedPayload {
  const items = payload.items.map((item) => ({ ...item, text: withoutControlCharacters(item.text.slice(0, maxCharsPerItem)) }));
  return UntrustedPayload.parse({ ...payload, items });
}

async function writeUntrustedPayload(laneCwd: string, payload: UntrustedPayload, maxCharsPerItem: number): Promise<string> {
  const payloadPath = path.join(laneCwd, UNTRUSTED_PAYLOAD_FILENAME);
  await writeJsonAtomic(payloadPath, boundedPayload(payload, maxCharsPerItem));
  return payloadPath;
}

export { writeUntrustedPayload };

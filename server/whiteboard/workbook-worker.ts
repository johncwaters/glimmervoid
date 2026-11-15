import fsp from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';

import { read, utils } from '@stackline/xlsx';

import { BOARD_WORKBOOK_UNPACKED_CAP_BYTES } from '../../shared/contracts/whiteboard.ts';
import { errorMessage } from '../../shared/text.ts';

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_DIRECTORY_ENTRY_BYTES = 46;

type WorkbookReply = { sheets: { name: string; csvText: string }[] } | { error: string; isUnpackedTooLarge: boolean };

function endOfDirectoryOffsetOf(zipBytes: Buffer): number {
  for (let offset = zipBytes.length - 4; offset >= 0; offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === ZIP_END_SIGNATURE) return offset;
  }
  throw new Error('the file is not a ZIP archive');
}

function inflatedLengthOf(deflatedBytes: Buffer, remainingBudgetBytes: number): number | null {
  try {
    return zlib.inflateRawSync(deflatedBytes, { maxOutputLength: Math.max(1, remainingBudgetBytes) }).length;
  } catch (error) {
    if (error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') return null;
    throw error;
  }
}

function isUnpackedWithinBudget(zipBytes: Buffer, budgetBytes: number): boolean {
  const endOfDirectory = endOfDirectoryOffsetOf(zipBytes);
  const entryCount = zipBytes.readUInt16LE(endOfDirectory + 8);
  let entryOffset = zipBytes.readUInt32LE(endOfDirectory + 16);
  let unpackedBytes = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const localHeaderOffset = zipBytes.readUInt32LE(entryOffset + 42);
    entryOffset += ZIP_DIRECTORY_ENTRY_BYTES + zipBytes.readUInt16LE(entryOffset + 28) + zipBytes.readUInt16LE(entryOffset + 30) + zipBytes.readUInt16LE(entryOffset + 32);
    if (zipBytes.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_SIGNATURE) throw new Error('a ZIP entry points at no local header');
    if (zipBytes.readUInt16LE(localHeaderOffset + 8) !== ZIP_DEFLATE_METHOD) continue;
    const dataOffset = localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + zipBytes.readUInt16LE(localHeaderOffset + 26) + zipBytes.readUInt16LE(localHeaderOffset + 28);
    const inflatedLength = inflatedLengthOf(zipBytes.subarray(dataOffset), budgetBytes - unpackedBytes);
    if (inflatedLength === null) return false;
    unpackedBytes += inflatedLength;
    if (unpackedBytes > budgetBytes) return false;
  }
  return true;
}

async function workbookReplyOf(workbookPath: unknown): Promise<WorkbookReply> {
  if (typeof workbookPath !== 'string') throw new Error('the workbook reader was given no file');
  const zipBytes = await fsp.readFile(workbookPath);
  if (!isUnpackedWithinBudget(zipBytes, BOARD_WORKBOOK_UNPACKED_CAP_BYTES)) return { error: 'the workbook unpacks past its budget', isUnpackedTooLarge: true };
  const workbook = read(zipBytes, { type: 'buffer' });
  const sheets = workbook.SheetNames.flatMap((name) => {
    const sheet = workbook.Sheets[name];
    return sheet ? [{ name, csvText: utils.sheet_to_csv(sheet) }] : [];
  });
  return { sheets };
}

function serve(): void {
  const port = parentPort;
  if (!port) throw new Error('the workbook reader runs only as a worker thread');
  workbookReplyOf(workerData).then((reply) => port.postMessage(reply), (error: unknown) => port.postMessage({ error: errorMessage(error), isUnpackedTooLarge: false }));
}

serve();

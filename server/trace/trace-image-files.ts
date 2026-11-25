import fsp from 'node:fs/promises';
import path from 'node:path';

import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonRecord } from '../core/json-core.ts';
import { imageBlobsIn, imageFileNameOf } from './core/trace-image-core.ts';
import type { LaneLog } from '../lanes/lane-log.ts';

interface PendingImageFile {
  fileName: string;
  bytes: Buffer;
}

const UPLOADS_DIRECTORY_MODE = 0o700;
const IMAGE_FILE_MODE = 0o600;

function imageFileNamesOf(record: TraceRecord): readonly string[] {
  if (record.kind === 'tool_result') return (record.images ?? []).map((image) => image.fileName);
  if (record.kind === 'attachments' && record.fromTranscript === true) return record.files;
  return [];
}

function pendingImageFilesOf(rawLine: string, records: readonly TraceRecord[]): PendingImageFile[] {
  const blobs = imageBlobsIn(parseJsonRecord(rawLine));
  const pendingByFileName = new Map<string, PendingImageFile>();
  for (const record of records) {
    const listedFileNames = new Set(imageFileNamesOf(record));
    for (const blob of blobs) {
      const fileName = imageFileNameOf(blob, record.ts);
      if (listedFileNames.has(fileName)) pendingByFileName.set(fileName, { fileName, bytes: Buffer.from(blob.base64, 'base64') });
    }
  }
  return [...pendingByFileName.values()];
}

function recordWithStoredImages(record: TraceRecord, storedFileNames: ReadonlySet<string>): TraceRecord[] {
  if (record.kind === 'tool_result' && record.images !== undefined) {
    const { images, ...recordWithoutImages } = record;
    const storedImages = images.filter((image) => storedFileNames.has(image.fileName));
    return [storedImages.length === 0 ? recordWithoutImages : { ...recordWithoutImages, images: storedImages }];
  }
  if (record.kind === 'attachments' && record.fromTranscript === true) {
    const storedFiles = record.files.filter((fileName) => storedFileNames.has(fileName));
    return storedFiles.length === 0 ? [] : [{ ...record, files: storedFiles }];
  }
  return [record];
}

function isAlreadyWritten(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function createTraceImageFiles(uploadsDirectoryOf: (glimmervoidSessionId: string) => string, laneLog: LaneLog) {
  async function writeImageFile(directory: string, pending: PendingImageFile): Promise<boolean> {
    try {
      await fsp.writeFile(path.join(directory, pending.fileName), pending.bytes, { flag: 'wx', mode: IMAGE_FILE_MODE });
      return true;
    } catch (error) {
      if (isAlreadyWritten(error)) return true;
      laneLog.warn('could not store a transcript image', { file: pending.fileName, error: errorMessage(error) });
      return false;
    }
  }

  async function storeImageFiles(glimmervoidSessionId: string, pendingFiles: readonly PendingImageFile[]): Promise<Set<string>> {
    const directory = uploadsDirectoryOf(glimmervoidSessionId);
    try {
      await fsp.mkdir(directory, { recursive: true, mode: UPLOADS_DIRECTORY_MODE });
    } catch (error) {
      laneLog.warn('could not create the uploads folder for transcript images', { session: glimmervoidSessionId, error: errorMessage(error) });
      return new Set();
    }
    const writtenFlags = await Promise.all(pendingFiles.map((pending) => writeImageFile(directory, pending)));
    return new Set(pendingFiles.filter((_, index) => writtenFlags[index]).map((pending) => pending.fileName));
  }

  async function withStoredImages(glimmervoidSessionId: string, rawLine: string, records: readonly TraceRecord[]): Promise<TraceRecord[]> {
    if (!records.some((record) => imageFileNamesOf(record).length > 0)) return [...records];
    const pendingFiles = pendingImageFilesOf(rawLine, records);
    const storedFileNames = pendingFiles.length === 0 ? new Set<string>() : await storeImageFiles(glimmervoidSessionId, pendingFiles);
    return records.flatMap((record) => recordWithStoredImages(record, storedFileNames));
  }

  return { withStoredImages };
}

export { createTraceImageFiles };

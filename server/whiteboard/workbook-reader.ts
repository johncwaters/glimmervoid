import { Worker } from 'node:worker_threads';

import { z } from 'zod';

import { workbookWorkerPath } from '../runtime-paths.ts';

const WORKBOOK_READ_TIMEOUT_MS = 15_000;
const WORKBOOK_READ_HEAP_MB = 256;

const WorkbookSheet = z.object({ name: z.string(), csvText: z.string() });
type WorkbookSheet = z.infer<typeof WorkbookSheet>;
const WorkbookReply = z.union([z.object({ sheets: z.array(WorkbookSheet) }), z.object({ error: z.string(), isUnpackedTooLarge: z.boolean() })]);

type WorkbookReading = { ok: true; sheets: WorkbookSheet[] } | { ok: false; error: string; isUnpackedTooLarge: boolean };

let latestWorkbookReading: Promise<WorkbookReading> = Promise.resolve({ ok: false, error: 'no workbook read yet', isUnpackedTooLarge: false });

function readingOf(message: unknown): WorkbookReading {
  const reply = WorkbookReply.safeParse(message);
  if (!reply.success) return { ok: false, error: 'the workbook reader gave an answer that could not be read', isUnpackedTooLarge: false };
  if ('error' in reply.data) return { ok: false, error: reply.data.error, isUnpackedTooLarge: reply.data.isUnpackedTooLarge };
  return { ok: true, sheets: reply.data.sheets };
}

function readWorkbookSheets(workbookPath: string): Promise<WorkbookReading> {
  latestWorkbookReading = latestWorkbookReading.then(() => readWorkbookSheetsInWorker(workbookPath));
  return latestWorkbookReading;
}

function readWorkbookSheetsInWorker(workbookPath: string): Promise<WorkbookReading> {
  return new Promise((resolve) => {
    const reader = new Worker(workbookWorkerPath, { workerData: workbookPath, env: {}, resourceLimits: { maxOldGenerationSizeMb: WORKBOOK_READ_HEAP_MB } });
    const settle = (reading: WorkbookReading) => {
      clearTimeout(readTimeout);
      resolve(reading);
      void reader.terminate();
    };
    const readTimeout = setTimeout(() => settle({ ok: false, error: `the workbook took longer than ${WORKBOOK_READ_TIMEOUT_MS / 1000} seconds to read`, isUnpackedTooLarge: false }), WORKBOOK_READ_TIMEOUT_MS);
    reader.once('message', (message: unknown) => settle(readingOf(message)));
    reader.once('error', (error: unknown) => settle({ ok: false, error: error instanceof Error ? error.message : String(error), isUnpackedTooLarge: false }));
    reader.once('exit', (exitCode) => settle({ ok: false, error: `the workbook reader stopped with exit code ${exitCode}`, isUnpackedTooLarge: false }));
  });
}

export { readWorkbookSheets };

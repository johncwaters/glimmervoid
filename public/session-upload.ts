import { reportUnsourcedError } from './action-status.ts';

type UploadTone = 'busy' | 'ok' | 'error';
type UploadReporter = (tone: UploadTone, text: string) => boolean;

const uploadReportersBySessionId = new Map<string, UploadReporter>();

export function registerUploadReporter(sessionId: string, reporter: UploadReporter, signal: AbortSignal) {
  uploadReportersBySessionId.set(sessionId, reporter);
  signal.addEventListener('abort', () => {
    if (uploadReportersBySessionId.get(sessionId) === reporter) uploadReportersBySessionId.delete(sessionId);
  }, { once: true });
}

function reportUpload(sessionId: string, tone: UploadTone, text: string) {
  const reporter = uploadReportersBySessionId.get(sessionId);
  const isShownByReporter = reporter ? reporter(tone, text) : false;
  if (isShownByReporter) return;
  if (tone === 'error') reportUnsourcedError(text);
}

export async function uploadFileToSession(sessionId: string, file: File): Promise<boolean> {
  const headers: Record<string, string> = { 'x-glimmervoid-upload-name': encodeURIComponent(file.name) };
  if (file.type) headers['content-type'] = file.type;
  reportUpload(sessionId, 'busy', `Uploading ${file.name}`);
  try {
    const res = await fetch(`/upload/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      body: file,
      headers,
    });
    if (res.ok) {
      reportUpload(sessionId, 'ok', `Uploaded ${file.name}`);
      return true;
    }
    reportUpload(sessionId, 'error', await uploadErrorText(res));
    return false;
  } catch {
    reportUpload(sessionId, 'error', 'Upload failed');
    return false;
  }
}

export async function uploadFilesToSession(sessionId: string, files: readonly File[]) {
  for (const file of files) await uploadFileToSession(sessionId, file);
}

async function uploadErrorText(res: Response) {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string') return `Upload failed: ${body.error}`;
  } catch {
  }
  return 'Upload failed';
}

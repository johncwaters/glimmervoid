import { clearHeaderError, reportHeaderError } from './action-status.ts';

const UPLOAD_ERROR_SOURCE = 'Upload';

export async function uploadFileToSession(sessionId: string, file: File): Promise<boolean> {
  clearHeaderError(UPLOAD_ERROR_SOURCE, sessionId);
  return attemptFileUpload(sessionId, file);
}

export async function uploadFilesToSession(sessionId: string, files: readonly File[]) {
  clearHeaderError(UPLOAD_ERROR_SOURCE, sessionId);
  for (const file of files) await attemptFileUpload(sessionId, file);
}

async function attemptFileUpload(sessionId: string, file: File): Promise<boolean> {
  const headers: Record<string, string> = { 'x-glimmervoid-upload-name': encodeURIComponent(file.name) };
  if (file.type) headers['content-type'] = file.type;
  try {
    const res = await fetch(`/upload/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      body: file,
      headers,
    });
    if (res.ok) return true;
    reportHeaderError({ source: UPLOAD_ERROR_SOURCE, sessionId, message: await uploadErrorText(res, file.name) });
    return false;
  } catch {
    reportHeaderError({ source: UPLOAD_ERROR_SOURCE, sessionId, message: `${file.name} was not uploaded because the server did not answer. Check that Glimmervoid is running, then drop the file again.` });
    return false;
  }
}

async function uploadErrorText(res: Response, fileName: string) {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string') return `${fileName} was not uploaded: ${body.error.replace(/\.$/, '')}. Fix that, then drop the file again.`;
  } catch {
  }
  return `${fileName} was not uploaded (HTTP ${res.status}). Drop the file again, or check the Glimmervoid terminal for errors.`;
}

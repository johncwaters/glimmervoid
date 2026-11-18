import { clearHeaderError, reportHeaderError } from './action-status.ts';

const UPLOAD_ERROR_SOURCE = 'Upload';

export async function uploadFileToSession(sessionId: string, file: File): Promise<boolean> {
  clearHeaderError(UPLOAD_ERROR_SOURCE, sessionId);
  return attemptFileUpload(sessionId, file);
}

export async function uploadFilesToSession(sessionId: string, files: readonly File[]): Promise<File[]> {
  clearHeaderError(UPLOAD_ERROR_SOURCE, sessionId);
  const uploadedFiles: File[] = [];
  for (const file of files) {
    if (await attemptFileUpload(sessionId, file)) uploadedFiles.push(file);
  }
  return uploadedFiles;
}

export async function storeFilesForChat(sessionId: string, files: readonly File[]): Promise<string[]> {
  clearHeaderError(UPLOAD_ERROR_SOURCE, sessionId);
  const storedFileNames: string[] = [];
  for (const file of files) {
    const fileName = await storedFileNameOf(await postUpload(sessionId, file, { 'x-glimmervoid-upload-mode': 'store' }));
    if (fileName !== null) storedFileNames.push(fileName);
  }
  return storedFileNames;
}

async function storedFileNameOf(res: Response | null): Promise<string | null> {
  if (!res?.ok) return null;
  try {
    const body = (await res.json()) as { fileName?: unknown } | null;
    return body && typeof body.fileName === 'string' ? body.fileName : null;
  } catch {
    return null;
  }
}

async function attemptFileUpload(sessionId: string, file: File): Promise<boolean> {
  const res = await postUpload(sessionId, file, {});
  return res?.ok === true;
}

async function postUpload(sessionId: string, file: File, extraHeaders: Record<string, string>): Promise<Response | null> {
  const headers: Record<string, string> = { 'x-glimmervoid-upload-name': encodeURIComponent(file.name), ...extraHeaders };
  if (file.type) headers['content-type'] = file.type;
  try {
    const res = await fetch(`/upload/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      body: file,
      headers,
    });
    if (!res.ok) reportHeaderError({ source: UPLOAD_ERROR_SOURCE, sessionId, message: await uploadErrorText(res, file.name) });
    return res;
  } catch {
    reportHeaderError({ source: UPLOAD_ERROR_SOURCE, sessionId, message: `${file.name} was not uploaded because the server did not answer. Check that Glimmervoid is running, then drop the file again.` });
    return null;
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

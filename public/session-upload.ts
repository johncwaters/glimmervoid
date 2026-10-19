import { reportUnsourcedError } from './action-status.ts';

export async function uploadFileToSession(sessionId: string, file: File): Promise<boolean> {
  const headers: Record<string, string> = { 'x-glimmervoid-upload-name': encodeURIComponent(file.name) };
  if (file.type) headers['content-type'] = file.type;
  try {
    const res = await fetch(`/upload/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      body: file,
      headers,
    });
    if (res.ok) return true;
    reportUnsourcedError(await uploadErrorText(res));
    return false;
  } catch {
    reportUnsourcedError('Upload failed');
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

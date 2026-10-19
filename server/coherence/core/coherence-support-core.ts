import { z } from 'zod';

const CoherencePackageManifest = z.object({ bin: z.union([z.string(), z.object({ coherence: z.string() })]) });

export function readCoherenceBinScript(manifestText: string): string | null {
  try {
    const manifest = CoherencePackageManifest.safeParse(JSON.parse(manifestText));
    if (!manifest.success) return null;
    return typeof manifest.data.bin === 'string' ? manifest.data.bin : manifest.data.bin.coherence;
  } catch {
    return null;
  }
}

export function judgeCoherenceSupport(output: string):
  { status: 'supported' | 'unsupported'; version: string } | { status: 'unreadable' } {
  const match = /^coherence (\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?:/u.exec(output.split(/\r?\n/, 1)[0]);
  if (!match) return { status: 'unreadable' };
  const version = match[0].slice('coherence '.length, -1);
  const isSupported = Number(match[1]) === 1 && Number(match[2]) >= 8 && !match[4];
  return { status: isSupported ? 'supported' : 'unsupported', version };
}

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BOARD_PAGE_ENTRY_PATH, BOARD_PAGE_MEMBERS_MAX } from '../../shared/contracts/whiteboard.ts';
import { isScriptFile, referencedPackPath, referencesIn, REMOTE_REFERENCE_PATTERN } from '../packs/core/pack-core.ts';

const MAX_LISTED_UNLOADED = 10;

type UnloadedReason = 'missing' | 'outside-folder' | 'absolute' | 'entry-name' | 'not-a-regular-file' | 'unreadable' | 'over-cap';

type UnloadedReference = { url: string; from: string; reason: UnloadedReason };

type BundleMember = { memberPath: string; hash: string; sizeBytes: number };

type StoredMember = { ok: true; hash: string; sizeBytes: number; storedPath: string } | { ok: false; reason: 'over-cap' | 'not-a-regular-file' | 'unreadable' };

type MemberStorer = (sourcePath: string, remainingBytes: number) => Promise<StoredMember>;

type PageBundle = { members: BundleMember[]; unloaded: UnloadedReference[] };

type PendingReference = { url: string; fromMemberPath: string; fromName: string };

const UNLOADED_REASON_TEXT: Readonly<Record<UnloadedReason, string>> = {
  missing: 'missing',
  'outside-folder': 'outside the page folder',
  absolute: 'an absolute path, which leaves the page folder',
  'entry-name': `named ${BOARD_PAGE_ENTRY_PATH}, the name the board gives the shown page itself`,
  'not-a-regular-file': 'not a regular file',
  unreadable: 'not readable',
  'over-cap': `past the bundle limit of ${BOARD_PAGE_MEMBERS_MAX} files or the board file size cap`,
};

function isScannedMember(memberPath: string): boolean {
  return memberPath.endsWith('.html') || memberPath.endsWith('.css') || isScriptFile(memberPath);
}

function pendingReferencesIn(memberPath: string, fromName: string, text: string): PendingReference[] {
  return referencesIn(memberPath, text).map(({ url }) => ({ url, fromMemberPath: memberPath, fromName }));
}

function isInside(folder: string, candidate: string): boolean {
  const relative = path.relative(folder, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function realSourceOf(pageFolder: string, memberPath: string): Promise<{ ok: true; sourcePath: string } | { ok: false; reason: UnloadedReason }> {
  const realPath = await fsp.realpath(path.join(pageFolder, ...memberPath.split('/'))).catch(() => null);
  if (realPath === null) return { ok: false, reason: 'missing' };
  if (!isInside(pageFolder, realPath)) return { ok: false, reason: 'outside-folder' };
  return { ok: true, sourcePath: realPath };
}

async function collectPageBundle({ pagePath, pageText, capBytes, storeMember }: { pagePath: string; pageText: string; capBytes: number; storeMember: MemberStorer }): Promise<PageBundle> {
  const pageFolder = await fsp.realpath(path.dirname(pagePath));
  const pageName = path.basename(pagePath);
  const members: BundleMember[] = [];
  const unloaded: UnloadedReference[] = [];
  const seenMemberPaths = new Set<string>();
  const pendingReferences = pendingReferencesIn(BOARD_PAGE_ENTRY_PATH, pageName, pageText);
  let remainingBytes = capBytes - Buffer.byteLength(pageText);
  const markUnloaded = (reference: PendingReference, reason: UnloadedReason) => unloaded.push({ url: reference.url, from: reference.fromName, reason });
  while (pendingReferences.length > 0) {
    const reference = pendingReferences.shift();
    if (!reference || REMOTE_REFERENCE_PATTERN.test(reference.url)) continue;
    if (reference.url.startsWith('/')) {
      markUnloaded(reference, 'absolute');
      continue;
    }
    const memberPath = referencedPackPath(reference.fromMemberPath, reference.url);
    if (memberPath === '.' || memberPath.endsWith('/') || seenMemberPaths.has(memberPath)) continue;
    seenMemberPaths.add(memberPath);
    if (memberPath === BOARD_PAGE_ENTRY_PATH) {
      if (pageName !== BOARD_PAGE_ENTRY_PATH) markUnloaded(reference, 'entry-name');
      continue;
    }
    if (memberPath.startsWith('../')) {
      markUnloaded(reference, 'outside-folder');
      continue;
    }
    if (members.length >= BOARD_PAGE_MEMBERS_MAX) {
      markUnloaded(reference, 'over-cap');
      continue;
    }
    const source = await realSourceOf(pageFolder, memberPath);
    if (!source.ok) {
      markUnloaded(reference, source.reason);
      continue;
    }
    const stored = await storeMember(source.sourcePath, remainingBytes);
    if (!stored.ok) {
      markUnloaded(reference, stored.reason);
      continue;
    }
    remainingBytes -= stored.sizeBytes;
    members.push({ memberPath, hash: stored.hash, sizeBytes: stored.sizeBytes });
    if (!isScannedMember(memberPath)) continue;
    const memberText = await fsp.readFile(stored.storedPath, 'utf8');
    pendingReferences.push(...pendingReferencesIn(memberPath, memberPath, memberText));
  }
  return { members, unloaded };
}

function manifestOf(pageHash: string, members: readonly BundleMember[]): { page: string; members: Record<string, string> } {
  const sortedMembers = [...members].sort((left, right) => (left.memberPath < right.memberPath ? -1 : 1));
  return { page: pageHash, members: Object.fromEntries(sortedMembers.map((member) => [member.memberPath, member.hash])) };
}

function bundleIdOf(pageHash: string, members: readonly BundleMember[]): string {
  if (members.length === 0) return pageHash;
  return crypto.createHash('sha256').update(JSON.stringify(manifestOf(pageHash, members))).digest('hex');
}

function unloadedNote(unloaded: readonly UnloadedReference[]): string | null {
  if (unloaded.length === 0) return null;
  const listed = unloaded.slice(0, MAX_LISTED_UNLOADED).map((reference) => `${reference.url} in ${reference.from} (${UNLOADED_REASON_TEXT[reference.reason]})`);
  const unlisted = unloaded.length - listed.length;
  const fileCount = unloaded.length === 1 ? '1 local file the page refers to does not load' : `${unloaded.length} local files the page refers to do not load`;
  return `${fileCount}: ${listed.join(', ')}${unlisted > 0 ? `, and ${unlisted} more` : ''}; put each file in the page folder or below and refer to it by a relative path`;
}

export { bundleIdOf, collectPageBundle, manifestOf, unloadedNote };
export type { StoredMember, UnloadedReference };

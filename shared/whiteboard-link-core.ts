import { z } from 'zod';

import { MediaLink } from './contracts/whiteboard.ts';
import type { LinkState, Op } from './contracts/whiteboard.ts';

type FileReading = { ok: true; hash: string } | { ok: false; problem: string };

const MediaWithLink = z.looseObject({ link: MediaLink });

const LINKABLE_MEDIA_KINDS: ReadonlySet<string> = new Set(['doc', 'page']);

const LINK_STATE_TEXT: Readonly<Record<Exclude<LinkState, 'broken'>, string>> = {
  'in-sync': 'In sync with the file',
  'file-ahead': 'The file changed; the card follows it on the next read',
  'card-ahead': 'Not saved to file',
  diverged: 'File changed on disk; Link again to reload the card from the file',
};

function linkStateOf(media: { asset: string; link: MediaLink }, file: FileReading): LinkState {
  if (!file.ok) return 'broken';
  const { syncedHash } = media.link;
  const isFileChanged = file.hash !== syncedHash;
  const isCardChanged = media.asset !== syncedHash;
  if (isFileChanged && isCardChanged) return file.hash === media.asset || syncedHash === null ? 'file-ahead' : 'diverged';
  if (isFileChanged) return 'file-ahead';
  return isCardChanged ? 'card-ahead' : 'in-sync';
}

function linkStateText(state: LinkState, file: FileReading): string {
  if (!file.ok) return file.problem;
  if (state === 'broken') return 'File missing';
  return LINK_STATE_TEXT[state];
}

function linkPathProblem(linkPath: string): string | null {
  if (linkPath.startsWith('/') || linkPath.startsWith('\\') || /^[A-Za-z]:/.test(linkPath)) return `the linked path ${linkPath} is absolute; give it relative to the board code session worktree`;
  if (linkPath.split(/[\\/]/).some((segment) => segment === '..')) return `the linked path ${linkPath} climbs out with ..; give it relative to the board code session worktree`;
  if (linkPath.includes('\0')) return 'a linked path holds no NUL character';
  return null;
}

function withServerSyncedHash(op: Op, currentLinkOf: (boxId: string) => MediaLink | null): Op {
  if (op.op !== 'set') return op;
  const sent = MediaWithLink.safeParse(op.fields.media);
  if (!sent.success || sent.data.link.syncedHash === null) return op;
  const currentLink = currentLinkOf(op.id);
  if (currentLink === null || currentLink.path !== sent.data.link.path) return op;
  return { ...op, fields: { ...op.fields, media: { ...sent.data, link: { ...sent.data.link, syncedHash: currentLink.syncedHash } } } };
}

function isLinkableMediaKind(kind: string): boolean {
  return LINKABLE_MEDIA_KINDS.has(kind);
}

export { isLinkableMediaKind, linkPathProblem, linkStateOf, linkStateText, withServerSyncedHash };
export type { FileReading };

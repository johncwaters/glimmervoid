import { TeamReviewThreadNode } from '../../shared/contracts/team-review.ts';

export const THREAD_BASE = 'b'.repeat(40);
export const THREAD_HEAD = 'a'.repeat(40);
export const THREAD_REPLY_AT = '2026-10-01T12:00:00Z';

export function threadNode(severity = 'MEDIUM', overrides: Partial<TeamReviewThreadNode> = {}): TeamReviewThreadNode {
  return TeamReviewThreadNode.parse({
    id: 'PRRT_acme_1', path: 'src/app.ts', line: 2, isResolved: false, viewerCanResolve: true,
    comments: { pageInfo: { hasNextPage: false }, nodes: [
      { body: `**[code/logic] ${severity}**\nCheck the empty input.`, author: { login: 'viewer' }, viewerDidAuthor: true, createdAt: '2026-10-01T10:00:00Z', url: 'https://github.com/Acme/app/pull/1#discussion_r1', originalCommit: { oid: THREAD_BASE } },
      { body: 'Added an empty input guard.', author: { login: 'teammate' }, viewerDidAuthor: false, createdAt: THREAD_REPLY_AT, url: 'https://github.com/Acme/app/pull/1#discussion_r2', originalCommit: { oid: THREAD_HEAD } },
    ] }, ...overrides,
  });
}

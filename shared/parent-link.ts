import type { ParentLink } from './contracts/session.ts';

export function ownerIdOf(parent: ParentLink | null | undefined): string | null {
  return parent && parent.box === null ? parent.sessionId : null;
}

export function branchParentIdOf(parent: ParentLink | null | undefined): string | null {
  return parent?.box ? parent.sessionId : null;
}

export function legacyParentLinkOf(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || 'parent' in raw) return raw;
  const { branchOf, ...rest } = raw as Record<string, unknown>;
  if (typeof branchOf !== 'object' || branchOf === null) return rest;
  const { parentId, aboutBoxId, aboutTitle } = branchOf as Record<string, unknown>;
  return { ...rest, parent: { sessionId: parentId, box: { id: aboutBoxId, title: aboutTitle } } };
}

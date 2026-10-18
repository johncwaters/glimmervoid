import type { ProjectCoherenceAdoptResult, ProjectCoherenceStatus } from '#shared/contracts/coherence.ts';

export function shouldOfferCoherenceAdopt(hasTrendReading: boolean, status: ProjectCoherenceStatus | undefined, isCoherenceEnabled: boolean, isFactoryProject: boolean): boolean {
  return !hasTrendReading && status?.configured === false && (isCoherenceEnabled || isFactoryProject);
}

export function coherenceAdoptReplyStatus(reply: ProjectCoherenceAdoptResult): string {
  if (!reply.ok && reply.ignoredPaths?.length) return `Adopt failed: git ignores ${reply.ignoredPaths.join(', ')}. Unignore them on the integration branch, then adopt again.`;
  if (!reply.ok) return `Adopt failed: ${reply.error ?? 'adopt failed'}`;
  if (reply.sha) return `Coherence adopted (${reply.sha.slice(0, 7)})`;
  return 'Coherence adopted';
}

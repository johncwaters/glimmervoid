export function lanePlaceholder(status: { configured?: boolean; reason?: unknown } | null | undefined, { label }: { label: string }) {
  if (!status) return `Waiting for ${label} status from the server.`;
  const reason = typeof status.reason === 'string' ? status.reason.trim() : '';
  if (status.configured === false && reason) return `${label} is misconfigured: ${reason}.`;
  if (status.configured === false) return `${label} is off.`;
  return `${label} is on. Waiting for the first poll.`;
}

export function watcherProblemNotice(status: object | null | undefined): string | null {
  const watcherProblem: unknown = status ? Object.getOwnPropertyDescriptor(status, 'watcherProblem')?.value : null;
  const problem = typeof watcherProblem === 'string' ? watcherProblem.trim() : '';
  if (!problem) return null;
  return `${problem}. Polling on a timer until it recovers.`;
}

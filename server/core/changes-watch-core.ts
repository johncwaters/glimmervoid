type ChangesWatch<Holder> = { holder: Holder; sessionId: string };

function decideWatchRequest<Holder>(
  current: ChangesWatch<Holder> | null,
  request: { holder: Holder; sessionId: string | null },
): { next: ChangesWatch<Holder> | null; shouldCheckNow: boolean } {
  if (request.sessionId === null) {
    const isHeldByRequester = current !== null && current.holder === request.holder;
    return { next: isHeldByRequester ? null : current, shouldCheckNow: false };
  }
  const isRenewal = current !== null && current.holder === request.holder && current.sessionId === request.sessionId;
  return {
    next: { holder: request.holder, sessionId: request.sessionId },
    shouldCheckNow: !isRenewal,
  };
}

export { decideWatchRequest };
export type { ChangesWatch };

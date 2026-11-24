const MAX_HANDSHAKES_IN_FLIGHT = 2;

export interface HandshakeRace<Attempt> {
  start(attempt: Attempt): void;
  adopt(attempt: Attempt): number | null;
  drop(attempt: Attempt): number;
  isRacing(attempt: Attempt): boolean;
  closeAll(): void;
}

export function createHandshakeRace<Attempt>(closeAttempt: (attempt: Attempt) => void): HandshakeRace<Attempt> {
  let attemptsInFlight: Attempt[] = [];
  let attemptsStarted = 0;

  function closeEvery(attempts: Attempt[]) {
    for (const attempt of attempts) closeAttempt(attempt);
  }

  return {
    start(attempt) {
      const overflowCount = attemptsInFlight.length + 1 - MAX_HANDSHAKES_IN_FLIGHT;
      const oldestAttempts = overflowCount > 0 ? attemptsInFlight.slice(0, overflowCount) : [];
      attemptsInFlight = [...attemptsInFlight.slice(oldestAttempts.length), attempt];
      attemptsStarted += 1;
      closeEvery(oldestAttempts);
    },
    adopt(attempt) {
      if (!attemptsInFlight.includes(attempt)) return null;
      const losingAttempts = attemptsInFlight.filter((candidate) => candidate !== attempt);
      const attemptsUsed = attemptsStarted;
      attemptsInFlight = [];
      attemptsStarted = 0;
      closeEvery(losingAttempts);
      return attemptsUsed;
    },
    drop(attempt) {
      attemptsInFlight = attemptsInFlight.filter((candidate) => candidate !== attempt);
      return attemptsInFlight.length;
    },
    isRacing(attempt) {
      return attemptsInFlight.includes(attempt);
    },
    closeAll() {
      const abandonedAttempts = attemptsInFlight;
      attemptsInFlight = [];
      attemptsStarted = 0;
      closeEvery(abandonedAttempts);
    },
  };
}

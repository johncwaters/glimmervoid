type PhoneEscalationDecision =
  | { action: 'escalate' }
  | { action: 'seen' }
  | { action: 'wait'; delayMs: number };

interface PhoneEscalationInput {
  pendingSinceMs: number;
  lastOperatorActivityMs: number | null;
  nowMs: number;
  phoneEscalationMs: number;
}

function decidePhoneEscalation({
  pendingSinceMs,
  lastOperatorActivityMs,
  nowMs,
  phoneEscalationMs,
}: PhoneEscalationInput): PhoneEscalationDecision {
  if (lastOperatorActivityMs === null || lastOperatorActivityMs < pendingSinceMs) return { action: 'escalate' };
  const operatorIdleMs = nowMs - lastOperatorActivityMs;
  if (operatorIdleMs >= phoneEscalationMs) return { action: 'escalate' };
  if (lastOperatorActivityMs >= pendingSinceMs + phoneEscalationMs) return { action: 'seen' };
  return { action: 'wait', delayMs: phoneEscalationMs - operatorIdleMs };
}

export { decidePhoneEscalation };

import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";

type DeliveryWhen = "now" | "idle" | "ready";

type DeliveryRefusal = "destroyed" | "no-pty" | "not-idle";

type DeliveryOutcome =
  | { ok: true; kind: "pasted" | "queued" }
  | { ok: false; kind: "refused"; reason: DeliveryRefusal };

type DeliverySettlement = "submitted" | "withheld" | "pasted" | "expired" | "dropped";

interface DeliverOptions {
  when: DeliveryWhen;
  submit: boolean;
  timeoutMs?: number;
  onSettled?: (settlement: DeliverySettlement) => void;
}

const PASTE_SETTLE_MS = 1500;
const SUBMIT_DELAY_MS = 300;
const QUEUED_DELIVERY_TIMEOUT_MS = 120_000;
const PASTE_BREAKING_CONTROL_BYTES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const LANDING_STATES: Record<Exclude<DeliveryWhen, "now">, readonly SessionState[]> = {
  ready: [STATES.IDLE, STATES.RUNNING, STATES.WAITING, STATES.COMPLETE],
  idle: [STATES.IDLE, STATES.COMPLETE],
};

function cleanPastedText(text: string): string {
  return text.replaceAll(PASTE_BREAKING_CONTROL_BYTES, "");
}

function framePaste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}

function canLandNow(when: DeliveryWhen, state: SessionState): boolean {
  if (when === "now") return true;
  return LANDING_STATES[when].includes(state);
}

function canSubmit({ when, state, pastedAt, lastOperatorInputAt }: { when: DeliveryWhen; state: SessionState; pastedAt: number; lastOperatorInputAt: number }): boolean {
  if (lastOperatorInputAt >= pastedAt) return false;
  return canLandNow(when, state);
}

export { PASTE_SETTLE_MS, QUEUED_DELIVERY_TIMEOUT_MS, SUBMIT_DELAY_MS, canLandNow, canSubmit, cleanPastedText, framePaste };
export type { DeliverOptions, DeliveryOutcome, DeliverySettlement, DeliveryWhen };

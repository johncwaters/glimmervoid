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
  onSettled?: (settlement: DeliverySettlement, detail?: string) => void;
}

const SUBMIT_DELAY_MS = 300;
const QUEUED_DELIVERY_TIMEOUT_MS = 120_000;
const SUBMITTED_TURN_GRACE_MS = 10_000;
const PASTE_BREAKING_CONTROL_BYTES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const READY_LANDING_STATES: readonly SessionState[] = [STATES.IDLE, STATES.RUNNING, STATES.WAITING, STATES.COMPLETE];

interface LandingFacts {
  state: SessionState;
  isBetweenTurns: boolean;
}

function cleanPastedText(text: string): string {
  return text.replaceAll(PASTE_BREAKING_CONTROL_BYTES, "");
}

function framePaste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}

function canLandNow(when: DeliveryWhen, landing: LandingFacts): boolean {
  if (when === "now") return true;
  if (when === "idle") return landing.isBetweenTurns;
  return READY_LANDING_STATES.includes(landing.state);
}

function canSubmit({ when, landing, pastedAt, lastOperatorInputAt }: { when: DeliveryWhen; landing: LandingFacts; pastedAt: number; lastOperatorInputAt: number }): boolean {
  if (lastOperatorInputAt >= pastedAt) return false;
  return canLandNow(when, landing);
}

export { QUEUED_DELIVERY_TIMEOUT_MS, SUBMIT_DELAY_MS, SUBMITTED_TURN_GRACE_MS, canLandNow, canSubmit, cleanPastedText, framePaste };
export type { DeliverOptions, DeliveryOutcome, DeliverySettlement, DeliveryWhen, LandingFacts };

import { randomUUID } from "node:crypto";
import { CHAT_OUTBOX_MAX_ENTRIES } from "../shared/contracts/session.ts";
import type { ChatOutboxEntry } from "../shared/contracts/session.ts";
import { unrefTimer } from "../shared/timer-deps.ts";
import type { DeliverySettlement } from "./core/input-delivery-core.ts";

const IN_FLIGHT_RECHECK_MS = 500;
const OUTBOX_FULL_TEXT = `${CHAT_OUTBOX_MAX_ENTRIES} messages are already waiting, so this one was not queued.`;

const UNDELIVERED_TEXT_BY_SETTLEMENT: Record<Exclude<DeliverySettlement, "submitted">, string> = {
  pasted: "The message is in the agent input box but was not sent, because text typed in the terminal is still waiting there. Open Terminal to send or clear it.",
  withheld: "The message is in the agent input box but was not sent, because you typed in the terminal meanwhile. Open Terminal to send or clear it.",
  expired: "The agent did not become ready in time, so the message was not sent.",
  dropped: "The session ended before the message was sent.",
};
const RESTARTED_TEXT = "The session restarted before the message was sent.";

interface ChatOutboxPort {
  canTakeMessage(): boolean;
  isDeliveryInFlight(): boolean;
  deliver(text: string, onSettled: (settlement: DeliverySettlement) => void): { ok: boolean; reason?: string };
  emitChange(entries: ChatOutboxEntry[]): void;
}

type QueueOutcome = { ok: true; entryId: string } | { ok: false; error: string };

interface ChatOutbox {
  entries(): ChatOutboxEntry[];
  queue(text: string): QueueOutcome;
  adopt(carriedEntries: readonly ChatOutboxEntry[]): void;
  cancel(entryId: string): string[];
  drain(): void;
  dispose(): void;
}

function createChatOutbox(port: ChatOutboxPort): ChatOutbox {
  let outboxEntries: ChatOutboxEntry[] = [];
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;

  function publish(nextEntries: ChatOutboxEntry[]): void {
    outboxEntries = nextEntries;
    port.emitChange(outboxEntries);
  }

  function replaceEntry(entryId: string, change: Partial<ChatOutboxEntry>): void {
    publish(outboxEntries.map((entry) => (entry.entryId === entryId ? { ...entry, ...change } : entry)));
  }

  function settle(entryId: string, settlement: DeliverySettlement): void {
    if (settlement === "submitted") {
      publish(outboxEntries.filter((entry) => entry.entryId !== entryId));
      drain();
      return;
    }
    replaceEntry(entryId, { state: "failed", failure: UNDELIVERED_TEXT_BY_SETTLEMENT[settlement] });
  }

  function recheckSoon(): void {
    if (recheckTimer) return;
    recheckTimer = unrefTimer(setTimeout(() => {
      recheckTimer = null;
      drain();
    }, IN_FLIGHT_RECHECK_MS));
  }

  function drain(): void {
    if (outboxEntries.some((entry) => entry.state !== "held")) return;
    const nextEntry = outboxEntries[0];
    if (!nextEntry || !port.canTakeMessage()) return;
    if (port.isDeliveryInFlight()) {
      recheckSoon();
      return;
    }
    replaceEntry(nextEntry.entryId, { state: "sending" });
    const delivery = port.deliver(nextEntry.text, (settlement) => settle(nextEntry.entryId, settlement));
    if (!delivery.ok) replaceEntry(nextEntry.entryId, { state: "failed", failure: `The message could not be typed into the session: ${delivery.reason ?? "unknown reason"}.` });
  }

  function queue(text: string): QueueOutcome {
    if (outboxEntries.length >= CHAT_OUTBOX_MAX_ENTRIES) return { ok: false, error: OUTBOX_FULL_TEXT };
    const entryId = randomUUID();
    publish([...outboxEntries, { entryId, text, state: "held", failure: null }]);
    drain();
    return { ok: true, entryId };
  }

  function cancel(entryId: string): string[] {
    const cancelIndex = outboxEntries.findIndex((entry) => entry.entryId === entryId);
    const cancelledEntry = outboxEntries[cancelIndex];
    if (!cancelledEntry || cancelledEntry.state === "sending") return [];
    const cancelledEntries = cancelledEntry.state === "failed" ? outboxEntries.slice(cancelIndex) : [cancelledEntry];
    publish(outboxEntries.filter((entry) => !cancelledEntries.includes(entry)));
    drain();
    return cancelledEntries.map((entry) => entry.text);
  }

  function adopt(carriedEntries: readonly ChatOutboxEntry[]): void {
    if (carriedEntries.length === 0) return;
    publish(carriedEntries.map((entry) => (entry.state === "sending" ? { ...entry, state: "failed", failure: RESTARTED_TEXT } : entry)));
    drain();
  }

  function dispose(): void {
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = null;
  }

  return { entries: () => outboxEntries, queue, adopt, cancel, drain, dispose };
}

export { createChatOutbox };
export type { ChatOutbox };

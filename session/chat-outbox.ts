import { randomUUID } from "node:crypto";
import { CHAT_OUTBOX_MAX_ENTRIES } from "../shared/contracts/session.ts";
import type { ChatOutboxEntry, ChatOutboxOrigin } from "../shared/contracts/session.ts";
import { unrefTimer } from "../shared/timer-deps.ts";
import type { DeliverySettlement } from "./core/input-delivery-core.ts";

const IN_FLIGHT_RECHECK_MS = 500;
const SUBMITTED_UNRECORDED_MAX_MS = 15_000;
const OUTBOX_FULL_TEXT = `${CHAT_OUTBOX_MAX_ENTRIES} messages are already waiting, so this one was not queued.`;

const UNDELIVERED_TEXT_BY_SETTLEMENT: Record<Exclude<DeliverySettlement, "submitted">, string> = {
  pasted: "The message is in the agent input box but was not sent, because text typed in the terminal is still waiting there. Open Terminal to send or clear it.",
  withheld: "The message is in the agent input box but was not sent, because you typed in the terminal meanwhile. Open Terminal to send or clear it.",
  expired: "The agent did not become ready in time, so the message was not sent.",
  dropped: "The session ended before the message was sent.",
};
const RESTARTED_TEXT = "The session restarted before the message was sent.";
const RESTARTED_BEFORE_TURN_TEXT = "The session restarted before a turn started for this message. Cancel to get the text back.";
const NOT_TAKEN_TEXT = "The agent did not start a turn for this message. Open Terminal to see why, or Cancel to get the text back.";

interface ChatOutboxPort {
  canTakeMessage(): boolean;
  reportsTurnStarts(): boolean;
  isDeliveryInFlight(): boolean;
  deliver(entry: ChatOutboxEntry, onSettled: (settlement: DeliverySettlement) => void): { ok: boolean; reason?: string };
  noteSubmitted(entry: ChatOutboxEntry): void;
  noteTaken(entry: ChatOutboxEntry, submittedAtMs: number): void;
  nowMs(): number;
  noteNotTaken(): void;
  emitChange(entries: ChatOutboxEntry[]): void;
}

type QueueOutcome = { ok: true; entryId: string } | { ok: false; error: string };

interface ChatOutbox {
  entries(): ChatOutboxEntry[];
  queue(text: string, attachments: readonly string[], origin: ChatOutboxOrigin): QueueOutcome;
  adopt(carriedEntries: readonly ChatOutboxEntry[]): void;
  cancel(entryId: string): ChatOutboxEntry[];
  sendNext(entryId: string): boolean;
  drain(): void;
  noteTurnTaken(): void;
  dispose(): void;
}

function isWaitingToSend(entry: ChatOutboxEntry): boolean {
  return entry.state === "held" || entry.state === "next";
}

function createChatOutbox(port: ChatOutboxPort): ChatOutbox {
  let outboxEntries: ChatOutboxEntry[] = [];
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  const unrecordedTimerByEntryId = new Map<string, ReturnType<typeof setTimeout>>();
  const submittedAtByEntryId = new Map<string, number>();

  function publish(nextEntries: ChatOutboxEntry[]): void {
    outboxEntries = nextEntries;
    port.emitChange(outboxEntries);
  }

  function replaceEntry(entryId: string, change: Partial<ChatOutboxEntry>): void {
    publish(outboxEntries.map((entry) => (entry.entryId === entryId ? { ...entry, ...change } : entry)));
  }

  function settle(entryId: string, settlement: DeliverySettlement): void {
    if (settlement === "submitted") {
      const submittedEntry = outboxEntries.find((entry) => entry.entryId === entryId);
      if (submittedEntry) port.noteSubmitted(submittedEntry);
      submittedAtByEntryId.set(entryId, port.nowMs());
      replaceEntry(entryId, { state: "submitted" });
      awaitTurnFor(entryId);
      drain();
      return;
    }
    replaceEntry(entryId, { state: "failed", failure: UNDELIVERED_TEXT_BY_SETTLEMENT[settlement] });
  }

  function stopUnrecordedTimers(): void {
    for (const timer of unrecordedTimerByEntryId.values()) clearTimeout(timer);
    unrecordedTimerByEntryId.clear();
  }

  function awaitTurnFor(entryId: string): void {
    unrecordedTimerByEntryId.set(entryId, unrefTimer(setTimeout(() => settleUnstartedTurn(entryId), SUBMITTED_UNRECORDED_MAX_MS)));
  }

  function markTaken(entry: ChatOutboxEntry): void {
    port.noteTaken(entry, submittedAtByEntryId.get(entry.entryId) ?? port.nowMs());
    submittedAtByEntryId.delete(entry.entryId);
  }

  function noteTurnTaken(): void {
    stopUnrecordedTimers();
    const takenEntries = outboxEntries.filter((entry) => entry.state === "submitted");
    if (takenEntries.length === 0) return;
    for (const takenEntry of takenEntries) markTaken(takenEntry);
    publish(outboxEntries.filter((entry) => entry.state !== "submitted"));
    drain();
  }

  function settleUnstartedTurn(entryId: string): void {
    unrecordedTimerByEntryId.delete(entryId);
    const submittedEntry = outboxEntries.find((entry) => entry.entryId === entryId && entry.state === "submitted");
    if (!submittedEntry) return;
    if (port.reportsTurnStarts()) {
      submittedAtByEntryId.delete(entryId);
      replaceEntry(entryId, { state: "failed", failure: NOT_TAKEN_TEXT });
      port.noteNotTaken();
      return;
    }
    markTaken(submittedEntry);
    publish(outboxEntries.filter((entry) => entry.entryId !== entryId));
    drain();
  }

  function recheckSoon(): void {
    if (recheckTimer) return;
    recheckTimer = unrefTimer(setTimeout(() => {
      recheckTimer = null;
      drain();
    }, IN_FLIGHT_RECHECK_MS));
  }

  function drain(): void {
    if (!outboxEntries.every(isWaitingToSend)) return;
    const nextEntry = outboxEntries.find(isWaitingToSend);
    if (!nextEntry || !port.canTakeMessage()) return;
    if (port.isDeliveryInFlight()) {
      recheckSoon();
      return;
    }
    replaceEntry(nextEntry.entryId, { state: "sending" });
    const delivery = port.deliver(nextEntry, (settlement) => settle(nextEntry.entryId, settlement));
    if (!delivery.ok) replaceEntry(nextEntry.entryId, { state: "failed", failure: `The message could not be typed into the session: ${delivery.reason ?? "unknown reason"}.` });
  }

  function queue(text: string, attachments: readonly string[], origin: ChatOutboxOrigin): QueueOutcome {
    if (outboxEntries.length >= CHAT_OUTBOX_MAX_ENTRIES) return { ok: false, error: OUTBOX_FULL_TEXT };
    const entryId = randomUUID();
    publish([...outboxEntries, { entryId, text, attachments: [...attachments], state: "held", failure: null, origin }]);
    drain();
    return { ok: true, entryId };
  }

  function cancel(entryId: string): ChatOutboxEntry[] {
    const cancelIndex = outboxEntries.findIndex((entry) => entry.entryId === entryId);
    const cancelledEntry = outboxEntries[cancelIndex];
    if (!cancelledEntry || cancelledEntry.state === "sending" || cancelledEntry.state === "submitted") return [];
    const cancelledEntries = cancelledEntry.state === "failed" ? outboxEntries.slice(cancelIndex) : [cancelledEntry];
    publish(outboxEntries.filter((entry) => !cancelledEntries.includes(entry)));
    drain();
    return cancelledEntries;
  }

  function sendNext(entryId: string): boolean {
    const heldEntry = outboxEntries.find((entry) => entry.entryId === entryId);
    if (heldEntry?.state !== "held") return false;
    if (outboxEntries.some((entry) => entry.state === "failed")) return false;
    const otherEntries = outboxEntries.filter((entry) => entry !== heldEntry);
    const firstHeldIndex = otherEntries.findIndex((entry) => entry.state === "held");
    const insertIndex = firstHeldIndex < 0 ? otherEntries.length : firstHeldIndex;
    publish([...otherEntries.slice(0, insertIndex), { ...heldEntry, state: "next" }, ...otherEntries.slice(insertIndex)]);
    return true;
  }

  function carriedEntryOf(entry: ChatOutboxEntry): ChatOutboxEntry {
    if (entry.state === "sending") return { ...entry, state: "failed", failure: RESTARTED_TEXT };
    if (entry.state !== "submitted") return entry;
    return { ...entry, state: "failed", failure: RESTARTED_BEFORE_TURN_TEXT };
  }

  function adopt(carriedEntries: readonly ChatOutboxEntry[]): void {
    if (carriedEntries.length === 0) return;
    publish(carriedEntries.map(carriedEntryOf));
    drain();
  }

  function dispose(): void {
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = null;
    stopUnrecordedTimers();
    submittedAtByEntryId.clear();
  }

  return { entries: () => outboxEntries, queue, adopt, cancel, sendNext, drain, noteTurnTaken, dispose };
}

export { createChatOutbox };
export type { ChatOutbox };

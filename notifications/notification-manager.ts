import { errorMessage } from "../shared/text.ts";
import { EventEmitter } from 'node:events';

import { NOTIFICATION_STATES as NS, NOTIFICATION_TRANSITIONS } from '../shared/notification-states.ts';
import { decidePhoneEscalation } from './core/phone-escalation-core.ts';
import type { OutcomeRecorder } from '../shared/outcome-names.ts';
import type { NotificationState } from '../shared/notification-states.ts';

type NotificationKind = 'plan';

export interface NotificationContext {
  escalationCount: number;
  timestamp: number;
  phoneEscalation?: boolean;
  kind?: NotificationKind;
}

interface ChannelDelivery {
  send?: boolean;
}

type NotificationChannelFn = (
  sessionName: string,
  category: string,
  message: string,
  context: NotificationContext,
) => ChannelDelivery | undefined;

interface RegisteredChannel {
  name: string;
  fn: NotificationChannelFn;
  offDashboard: boolean;
  canEscalate: () => boolean;
}

interface NotificationEntry {
  state: NotificationState;
  category: string | null;
  message: string | null;
  kind: NotificationKind | null;
  timer: NodeJS.Timeout | null;
  escalationCount: number;
  phoneTimer: NodeJS.Timeout | null;
  hasReachedPhone: boolean;
  pendingSinceMs: number;
}

export interface NotificationManagerOptions {
  escalationIntervalMs?: number;
  debounceMs?: number;
  phoneEscalationMs?: number;
}

interface NotificationManagerDependencies extends NotificationManagerOptions {
  recordOutcome?: OutcomeRecorder;
  now?: () => number;
}

class NotificationManager extends EventEmitter {
  _entries: Map<string, NotificationEntry>;
  _channels: RegisteredChannel[];
  _focusSuppressed: boolean;
  _escalationIntervalMs: number;
  _debounceMs: number;
  _phoneEscalationMs: number;
  _recentCategories: Map<string, number>;
  _recordOutcome: OutcomeRecorder;
  _now: () => number;
  _lastOperatorActivityMs: number | null;

  constructor({
    escalationIntervalMs = 300000,
    debounceMs = 3000,
    phoneEscalationMs = 300000,
    recordOutcome = () => {},
    now = () => Date.now(),
  }: NotificationManagerDependencies = {}) {
    super();
    this._entries = new Map();
    this._channels = [];
    this._focusSuppressed = false;
    this._escalationIntervalMs = escalationIntervalMs;
    this._debounceMs = debounceMs;
    this._phoneEscalationMs = phoneEscalationMs;
    this._recentCategories = new Map();
    this._recordOutcome = recordOutcome;
    this._now = now;
    this._lastOperatorActivityMs = null;
  }


  getNotificationState(sessionName: string): NotificationState {
    const entry = this._entries.get(sessionName);
    return entry ? entry.state : NS.IDLE;
  }

  registerChannel(
    name: string,
    fn: NotificationChannelFn,
    { offDashboard = false, canEscalate = () => true }: { offDashboard?: boolean; canEscalate?: () => boolean } = {},
  ): void {
    this._channels.push({ name, fn, offDashboard, canEscalate });
  }

  setFocusSuppressed(val: unknown): void {
    const was = this._focusSuppressed;
    this._focusSuppressed = !!val;
    if (was && !this._focusSuppressed) {
      for (const name of [...this._entries.keys()]) {
        const entry = this._entries.get(name);
        if (entry && entry.state === NS.SUPPRESSED) this._transition(name, 'unsuppress');
      }
    }
  }

  trigger(sessionName: string, category: string, message: string, kind: NotificationKind | null = null): boolean {
    this._ensureEntry(sessionName);
    const entry = this._entries.get(sessionName);
    if (!entry) return false;
    const stateTransitions = NOTIFICATION_TRANSITIONS[entry.state];
    if (!stateTransitions || !('trigger' in stateTransitions)) return false;
    entry.category = category;
    entry.message = message;
    entry.kind = kind;
    entry.escalationCount = 0;
    return this._transition(sessionName, 'trigger');
  }

  acknowledge(sessionName: string): void {
    const entry = this._entries.get(sessionName);
    if (!entry || entry.state === NS.IDLE) return;
    this._transition(sessionName, 'acknowledge');
  }

  noteOperatorActivity(): void {
    this._lastOperatorActivityMs = this._now();
  }

  markPhoneReached(sessionName: string): void {
    const entry = this._entries.get(sessionName);
    if (!entry) return;
    this._markPhoneReached(entry);
  }

  updateSettings({ escalationIntervalMs, debounceMs, phoneEscalationMs }: NotificationManagerOptions): void {
    if (escalationIntervalMs != null) this._escalationIntervalMs = escalationIntervalMs;
    if (debounceMs != null) this._debounceMs = debounceMs;
    if (phoneEscalationMs != null) this._phoneEscalationMs = phoneEscalationMs;
  }

  destroy(): void {
    for (const [, entry] of this._entries) {
      this._clearTimer(entry);
      this._clearPhoneTimer(entry);
    }
    this._entries.clear();
    this._recentCategories.clear();
    this._channels = [];
    this.removeAllListeners();
  }


  _ensureEntry(sessionName: string): void {
    if (!this._entries.has(sessionName)) {
      this._entries.set(sessionName, {
        state: NS.IDLE,
        category: null,
        message: null,
        kind: null,
        timer: null,
        escalationCount: 0,
        phoneTimer: null,
        hasReachedPhone: false,
        pendingSinceMs: 0,
      });
    }
  }

  _transition(sessionName: string, event: string): boolean {
    const entry = this._entries.get(sessionName);
    if (!entry) return false;

    const stateTransitions = NOTIFICATION_TRANSITIONS[entry.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      return false;
    }

    const from = entry.state;
    const to = stateTransitions[event];
    if (!to) return false;

    if (from === to) return true;

    this._exitHook(sessionName, entry, from);

    entry.state = to;

    this._entryHook(sessionName, entry, to);

    this.emit('notification-state-change', {
      session: sessionName,
      from, to, event,
      category: entry.category,
    });

    return true;
  }

  _entryHook(sessionName: string, entry: NotificationEntry, state: NotificationState): void {
    switch (state) {
      case NS.PENDING:
        this._clearPhoneTimer(entry);
        entry.hasReachedPhone = false;
        entry.pendingSinceMs = this._now();
        if (this._focusSuppressed) {
          this._transition(sessionName, 'suppressed');
          return;
        }
        if (this._isDebounced(sessionName, entry.category)) {
          this._transition(sessionName, 'debounced');
          return;
        }
        this._transition(sessionName, 'deliver');
        break;

      case NS.SUPPRESSED:
        this._armPhoneEscalation(sessionName, entry);
        break;

      case NS.DELIVERED:
        if (entry.escalationCount === 0) {
          this._recordCategory(sessionName, entry.category);
        }
        this._deliverViaChannels(sessionName, entry);
        if (entry.category === 'waiting') {
          this._armEscalation(sessionName, entry);
        }
        this._armPhoneEscalation(sessionName, entry);
        break;

      case NS.ESCALATED:
        entry.escalationCount++;
        this._deliverViaChannels(sessionName, entry);
        this._armEscalation(sessionName, entry);
        break;

      case NS.ESCALATED_PHONE:
        this._deliverViaChannels(sessionName, entry, { phoneEscalation: true }, (channel) => channel.offDashboard);
        this._markPhoneReached(entry);
        if (entry.category === 'waiting') {
          this._armEscalation(sessionName, entry);
        }
        break;

      case NS.ACKNOWLEDGED:
        this._clearTimer(entry);
        this._clearPhoneTimer(entry);
        this._transition(sessionName, 'reset');
        break;

      case NS.IDLE:
        this._clearTimer(entry);
        this._clearPhoneTimer(entry);
        this._entries.delete(sessionName);
        break;
    }
  }

  _armEscalation(sessionName: string, entry: NotificationEntry): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this._transition(sessionName, 'escalation_tick');
    }, this._escalationIntervalMs);
  }

  _armPhoneEscalation(sessionName: string, entry: NotificationEntry): void {
    if (entry.hasReachedPhone) return;
    if (entry.phoneTimer !== null) return;
    if (!(this._phoneEscalationMs > 0)) return;
    if (!this._channels.some((channel) => channel.offDashboard && channel.canEscalate())) return;
    this._schedulePhoneCheck(sessionName, entry, this._phoneEscalationMs);
  }

  _schedulePhoneCheck(sessionName: string, entry: NotificationEntry, delayMs: number): void {
    entry.phoneTimer = setTimeout(() => {
      entry.phoneTimer = null;
      this._resolvePhoneEscalation(sessionName, entry);
    }, delayMs);
    entry.phoneTimer.unref();
  }

  _resolvePhoneEscalation(sessionName: string, entry: NotificationEntry): void {
    const decision = decidePhoneEscalation({
      pendingSinceMs: entry.pendingSinceMs,
      lastOperatorActivityMs: this._lastOperatorActivityMs,
      nowMs: this._now(),
      phoneEscalationMs: this._phoneEscalationMs,
    });
    if (decision.action === 'wait') {
      this._schedulePhoneCheck(sessionName, entry, decision.delayMs);
      return;
    }
    if (decision.action === 'seen') {
      this._markPhoneReached(entry);
      return;
    }
    this._transition(sessionName, 'phone_escalation');
  }

  _exitHook(_sessionName: string, entry: NotificationEntry, state: NotificationState): void {
    if (state === NS.DELIVERED || state === NS.ESCALATED || state === NS.ESCALATED_PHONE) {
      this._clearTimer(entry);
    }
  }


  _deliverViaChannels(
    sessionName: string,
    entry: NotificationEntry,
    extraContext: { phoneEscalation?: boolean } | null = null,
    channelFilter: ((channel: RegisteredChannel) => boolean) | null = null,
  ): void {
    const { category, message } = entry;
    if (category === null || message === null) return;
    const context = {
      escalationCount: entry.escalationCount,
      timestamp: Date.now(),
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(extraContext || {}),
    };
    for (const channel of this._channels) {
      if (channelFilter && !channelFilter(channel)) continue;
      if (channel.offDashboard && entry.hasReachedPhone) continue;
      try {
        const delivery = channel.fn(sessionName, category, message, context);
        if (channel.offDashboard && delivery?.send === true) this._markPhoneReached(entry);
        this._recordOutcome('notifyDelivered');
      } catch (err) {
        this._recordOutcome('notifyFailed');
        console.warn(`[channel:${channel.name}] delivery failed: ${errorMessage(err)}`);
      }
    }
  }


  _isDebounced(sessionName: string, category: string | null): boolean {
    if (!category) return false;
    const now = Date.now();
    const lastFired = this._recentCategories.get(`${sessionName}\0${category}`);
    return lastFired !== undefined && (now - lastFired) < this._debounceMs;
  }

  _recordCategory(sessionName: string, category: string | null): void {
    if (!category) return;
    const now = Date.now();
    for (const [key, ts] of this._recentCategories) {
      if (now - ts >= this._debounceMs) this._recentCategories.delete(key);
    }
    this._recentCategories.set(`${sessionName}\0${category}`, now);
  }


  _clearTimer(entry: NotificationEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  _markPhoneReached(entry: NotificationEntry): void {
    entry.hasReachedPhone = true;
    this._clearPhoneTimer(entry);
  }

  _clearPhoneTimer(entry: NotificationEntry): void {
    if (entry.phoneTimer != null) {
      clearTimeout(entry.phoneTimer);
      entry.phoneTimer = null;
    }
  }
}

export { NotificationManager };

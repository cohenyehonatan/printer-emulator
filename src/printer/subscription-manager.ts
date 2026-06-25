/**
 * IPP event-notification Subscription objects + manager (RFC 3995 / RFC 3996).
 *
 * The pull-mode (ippget) half of the notification model. A client creates a
 * Subscription naming the `notify-events` it cares about; thereafter, whenever
 * the printer records a matching event (job created/completed/state-changed,
 * printer-state-changed, …), the manager appends an EventRecord to every
 * subscription whose `notify-events` set matches — assigning each a per-
 * subscription monotonic `notify-sequence-number`. A later Get-Notifications
 * (RFC 3996) DRAINS the subscription's queue, returning one event-notification
 * group per pending event.
 *
 * Leases (notify-lease-duration) expire WITHOUT any wall-clock timer: a
 * subscription carries an absolute `expiresAt` epoch-ms, and every accessor
 * (get/list/recordEvent/drain) first prunes whatever has expired as of "now".
 * This keeps the emulator timer-free (a `vitest run` exits on its own) while
 * still honoring lease semantics. A lease of 0 means "no expiry" (granted as
 * the printer's maximum), per RFC 3995.
 *
 * Drain semantics: DRAIN-ON-READ. Get-Notifications returns the events queued
 * since the previous Get-Notifications for that subscription and removes them
 * from the queue; a subsequent call with no new events returns an empty event
 * set. The `notify-sequence-number` still advances monotonically across drains,
 * so a client can tell how many events it has seen.
 */

import {
  NOTIFY_LEASE_DURATION_DEFAULT,
  NOTIFY_LEASE_DURATION_MIN,
  NOTIFY_LEASE_DURATION_MAX,
  NOTIFY_MAX_EVENTS,
  NOTIFY_PULL_METHOD_IPPGET,
  type JobStateValue,
  type PrinterStateValue,
} from '../ipp/constants.js';

/**
 * One event the printer records (job/printer state change). `subscribedEvent`
 * is the `notify-events` keyword this event matches; the optional job/printer
 * fields are filled per event type so Get-Notifications can surface them.
 */
export interface PrinterEvent {
  /** The `notify-events` keyword (e.g. `job-completed`). */
  event: string;
  /** Job id for a job-* event; undefined for printer-* events. */
  jobId?: number;
  /** Job state for a job-* event (RFC 8011 numeric). */
  jobState?: JobStateValue;
  /** Printer state for a printer-* event (RFC 8011 numeric). */
  printerState?: PrinterStateValue;
}

/** A queued event within a subscription, stamped with its sequence number. */
export interface EventRecord extends PrinterEvent {
  /** Per-subscription monotonic `notify-sequence-number` (starts at 1). */
  sequenceNumber: number;
  /** printer-up-time (seconds) at the moment the event was recorded. */
  printerUpTime: number;
}

/** Parameters for creating a Subscription (parsed from the request group). */
export interface SubscriptionInit {
  /** The `notify-events` keyword set (already validated/normalized). */
  events: string[];
  /** Requested `notify-lease-duration` in seconds (undefined → default). */
  leaseDuration?: number;
  /** `notify-job-id` for a Create-Job-Subscriptions (per-job) subscription. */
  jobId?: number;
  /** `requesting-user-name`, recorded for Get-Subscriptions `my-subscriptions`. */
  userName?: string;
}

/** A live notification subscription with its own event queue. */
export class Subscription {
  readonly id: number;
  readonly events: string[];
  readonly jobId: number | undefined;
  readonly userName: string;
  /** Always `ippget` in this pull-only emulator. */
  readonly pullMethod = NOTIFY_PULL_METHOD_IPPGET;
  /** Granted lease in seconds (0 ⇒ no expiry). */
  private _leaseDuration: number;
  /** Absolute expiry as epoch-ms, or null when the lease never expires. */
  private _expiresAt: number | null;
  /** Last assigned `notify-sequence-number` (0 before the first event). */
  private _lastSequence = 0;
  /** Pending events, oldest first. Drained by Get-Notifications. */
  private _queue: EventRecord[] = [];

  constructor(id: number, init: SubscriptionInit, now: number) {
    this.id = id;
    this.events = init.events;
    this.jobId = init.jobId;
    this.userName = init.userName ?? 'anonymous';
    this._leaseDuration = clampLease(init.leaseDuration);
    this._expiresAt = leaseExpiry(this._leaseDuration, now);
  }

  /** The granted `notify-lease-duration` (seconds; 0 ⇒ no expiry). */
  get leaseDuration(): number {
    return this._leaseDuration;
  }

  /** The most recently assigned `notify-sequence-number`. */
  get lastSequence(): number {
    return this._lastSequence;
  }

  /** Whether this subscription's `notify-events` set includes `event`. */
  matches(event: string): boolean {
    return this.events.includes(event);
  }

  /** Whether the lease has expired as of `now` (epoch-ms). */
  isExpired(now: number): boolean {
    return this._expiresAt !== null && now >= this._expiresAt;
  }

  /**
   * Append an event to this subscription's queue with the next sequence number,
   * capturing `printerUpTime` (seconds). When the queue is at
   * NOTIFY_MAX_EVENTS the oldest event is dropped (sequence still advances).
   */
  append(event: PrinterEvent, printerUpTime: number): void {
    this._lastSequence += 1;
    this._queue.push({
      ...event,
      sequenceNumber: this._lastSequence,
      printerUpTime,
    });
    if (this._queue.length > NOTIFY_MAX_EVENTS) {
      this._queue.shift();
    }
  }

  /** Drain and return all pending events (oldest first); empties the queue. */
  drain(): EventRecord[] {
    const drained = this._queue;
    this._queue = [];
    return drained;
  }

  /**
   * Renew the lease: re-grant `leaseDuration` seconds (clamped) from `now`.
   * Returns the granted duration.
   */
  renew(leaseDuration: number | undefined, now: number): number {
    this._leaseDuration = clampLease(leaseDuration);
    this._expiresAt = leaseExpiry(this._leaseDuration, now);
    return this._leaseDuration;
  }
}

/** Clamp a requested lease into [MIN, MAX]; absent/0 → default/max policy. */
function clampLease(requested: number | undefined): number {
  // RFC 3995: a requested 0 means "as long as the printer will grant" — we map
  // that to the maximum (treated as no-expiry by leaseExpiry). Absence → default.
  if (requested === undefined) return NOTIFY_LEASE_DURATION_DEFAULT;
  if (!Number.isFinite(requested)) return NOTIFY_LEASE_DURATION_DEFAULT;
  if (requested <= 0) return NOTIFY_LEASE_DURATION_MAX;
  return Math.min(
    NOTIFY_LEASE_DURATION_MAX,
    Math.max(NOTIFY_LEASE_DURATION_MIN, Math.trunc(requested))
  );
}

/** Absolute expiry epoch-ms for a granted lease (the MAX grant ⇒ no expiry). */
function leaseExpiry(leaseDuration: number, now: number): number | null {
  if (leaseDuration >= NOTIFY_LEASE_DURATION_MAX) return null;
  return now + leaseDuration * 1000;
}

/**
 * Owns the set of live subscriptions and the monotonic subscription-id counter.
 * Every accessor prunes expired leases first (lazily, no timers). `recordEvent`
 * fans an event out to all matching, unexpired subscriptions. The manager is
 * given a `printerUpTime()` source so event records carry the live up-time.
 */
export class SubscriptionManager {
  private nextId = 1;
  private subscriptions: Subscription[] = [];

  constructor(private readonly printerUpTime: () => number) {}

  /** Create + register a subscription, assigning the next subscription-id. */
  create(init: SubscriptionInit, now: number = Date.now()): Subscription {
    this.prune(now);
    const sub = new Subscription(this.nextId++, init, now);
    this.subscriptions.push(sub);
    return sub;
  }

  /** Look up a subscription by id (undefined when unknown or expired). */
  get(id: number, now: number = Date.now()): Subscription | undefined {
    this.prune(now);
    return this.subscriptions.find((s) => s.id === id);
  }

  /**
   * List live subscriptions, optionally filtered by `notify-job-id` and/or a
   * `my-subscriptions` user name. Returns them in creation (id) order.
   */
  list(
    filter: { jobId?: number; userName?: string } = {},
    now: number = Date.now()
  ): Subscription[] {
    this.prune(now);
    return this.subscriptions.filter((s) => {
      if (filter.jobId !== undefined && s.jobId !== filter.jobId) return false;
      if (filter.userName !== undefined && s.userName !== filter.userName) {
        return false;
      }
      return true;
    });
  }

  /** Cancel (remove) a subscription by id. Returns true when one was removed. */
  cancel(id: number, now: number = Date.now()): boolean {
    this.prune(now);
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
    return this.subscriptions.length < before;
  }

  /**
   * Record an event: append it to every live subscription whose `notify-events`
   * matches. A job-* event is also delivered to a per-job subscription only
   * when its `notify-job-id` matches the event's job-id (a printer-wide
   * subscription — no notify-job-id — matches any job). printer-* events go to
   * subscriptions with no notify-job-id. No matching subscriptions ⇒ no-op.
   */
  recordEvent(event: PrinterEvent, now: number = Date.now()): void {
    this.prune(now);
    const upTime = this.printerUpTime();
    for (const sub of this.subscriptions) {
      if (!sub.matches(event.event)) continue;
      // Scope a per-job subscription to its job; a printer-wide subscription
      // (no jobId) sees every event it subscribed to.
      if (sub.jobId !== undefined && sub.jobId !== event.jobId) continue;
      sub.append(event, upTime);
    }
  }

  /**
   * Drain a subscription's queued events (Get-Notifications). Returns undefined
   * when the subscription is unknown/expired so the caller can return not-found.
   */
  drain(id: number, now: number = Date.now()): EventRecord[] | undefined {
    this.prune(now);
    const sub = this.subscriptions.find((s) => s.id === id);
    if (!sub) return undefined;
    return sub.drain();
  }

  /** Number of live subscriptions (after pruning). */
  size(now: number = Date.now()): number {
    this.prune(now);
    return this.subscriptions.length;
  }

  /** Drop every subscription whose lease has expired as of `now`. */
  private prune(now: number): void {
    this.subscriptions = this.subscriptions.filter((s) => !s.isExpired(now));
  }
}

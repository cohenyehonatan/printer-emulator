/**
 * IPP Job object + lifecycle.
 *
 * A Job (RFC 8011 §4.3) wraps one or more submitted documents, a monotonic
 * job-id, and a JobStateMachine driving the RFC 8011 lifecycle. Transition
 * helpers map the IPP operations (Print-Job, Create-Job, Send-Document,
 * Close-Job, Cancel-Job) onto JobEvents and surface the current numeric
 * job-state for response encoding.
 *
 * Two creation shapes are supported:
 *   - Single-shot Print-Job: one document, the job is closed immediately and
 *     starts life PENDING, then process() drives it to completion.
 *   - Multi-document Create-Job: zero documents at first, the job starts
 *     PENDING_HELD ("open", waiting for Send-Document), accumulates documents,
 *     and is released (close()) on last-document / Close-Job.
 */

import { JobStateMachine } from './state-machine.js';
import { JobState, JobEvent, jobStateToValue } from './states.js';
import { JobHoldUntil, type JobStateValue } from '../ipp/constants.js';
import { holdUntilHolds } from '../ipp/hold-until.js';
import type { Document } from '../documents/document.js';

/**
 * The settable job-description / job-template attributes this emulator honors
 * via Set-Job-Attributes (RFC 3380 §4.2), advertised in
 * `job-settable-attributes-supported`. Each maps onto a Job field that
 * Get-Job-Attributes / Get-Jobs reflect. Kept here so the writable set and its
 * advertisement stay in one place.
 */
export const JOB_SETTABLE_ATTRIBUTES = [
  'job-name',
  'job-priority',
  'copies',
  'job-hold-until',
] as const;

export interface JobInit {
  id: number;
  printerUri: string;
  /**
   * The job's first document. Omitted for Create-Job, which allocates an
   * "open" job that receives its documents later via Send-Document.
   */
  document?: Document;
  jobName?: string;
  requestingUserName?: string;
  /**
   * Total impressions (sides/pages) of the supplied first document. Populated
   * from a parsed raster page count when known; defaults to 1 for
   * non-raster/unparsed input. Additional documents add to this via
   * addDocument().
   */
  impressions?: number;
  /**
   * When true the job starts "open" (multi-document, PENDING_HELD) and waits
   * for Send-Document calls. When false/omitted it is a closed single-shot job
   * (PENDING) — the existing Print-Job behavior.
   */
  open?: boolean;
  /**
   * The requested `job-hold-until` keyword (RFC 8011 §5.2.2), if the client
   * supplied one. Stored verbatim so Get-Job-Attributes can echo it. A value
   * other than `no-hold` causes a single-shot Print-Job to start PENDING_HELD;
   * `no-hold` (or absence) leaves the existing behavior. See hold-until.ts for
   * the keyword→hold policy.
   */
  holdUntil?: string;
}

export class Job {
  readonly id: number;
  readonly printerUri: string;
  private _jobName: string;
  readonly requestingUserName: string;
  /**
   * `job-priority` (RFC 8011 §5.2.4, 1–100; higher prints sooner) and `copies`
   * (§5.2.5, ≥1). Settable via Set-Job-Attributes (RFC 3380 §4.2) and echoed by
   * Get-Job-Attributes once a client sets one. `undefined` until set so the
   * default job-attribute set stays unchanged for jobs that never carried them.
   */
  private _jobPriority: number | undefined;
  private _copies: number | undefined;
  readonly createdAt: Date;
  private readonly _documents: Document[] = [];
  private _impressions: number;
  /** Whether the job is still accepting documents (Create-Job/Send-Document). */
  private _open: boolean;
  /**
   * The job's current `job-hold-until` keyword (RFC 8011 §5.2.2), or undefined
   * when the client never specified one. Mutated by Hold-Job/Release-Job so
   * Get-Job-Attributes always echoes the effective value.
   */
  private _holdUntil: string | undefined;
  /**
   * Number of times this job has run to `completed`. Starts at 0 and increments
   * each time process() reaches COMPLETE. A Restart-Job (§4.3.7) re-queues a
   * terminal job and runs it again, so a second completion bumps this to 2 —
   * giving callers/tests an observable "it actually re-ran" signal (a fresh run
   * is otherwise invisible because impressions-completed is derived from state).
   */
  private _runs = 0;
  private readonly sm: JobStateMachine;

  constructor(init: JobInit) {
    this.id = init.id;
    this.printerUri = init.printerUri;
    this._jobName = init.jobName ?? `job-${init.id}`;
    this.requestingUserName = init.requestingUserName ?? 'anonymous';
    this.createdAt = new Date();
    this._open = init.open ?? false;
    this._holdUntil = init.holdUntil;

    if (init.document) {
      this._documents.push(init.document);
      this._impressions = Math.max(1, init.impressions ?? 1);
    } else {
      // An open job with no documents yet contributes no impressions until one
      // is added; we floor the *reported* impressions to 1 via the getter.
      this._impressions = 0;
    }

    // Multi-document jobs wait held for their documents; single-shot jobs are
    // immediately pending — UNLESS a holding `job-hold-until` (anything but
    // `no-hold`) was requested, in which case the single-shot job also starts
    // PENDING_HELD and waits for a Release-Job.
    const startHeld = this._open || holdUntilHolds(this._holdUntil);
    this.sm = new JobStateMachine(
      startHeld ? JobState.PENDING_HELD : JobState.PENDING
    );
  }

  /** The underlying state machine (for observers/logging). */
  get stateMachine(): JobStateMachine {
    return this.sm;
  }

  /** Current job state as an enum. */
  get state(): JobState {
    return this.sm.getState();
  }

  /** Current job-state as its RFC 8011 numeric value. */
  get stateValue(): JobStateValue {
    return jobStateToValue(this.sm.getState());
  }

  /** All documents attached to this job, in submission order. */
  get documents(): readonly Document[] {
    return this._documents;
  }

  /**
   * The job's primary document. For single-shot Print-Job this is the only
   * document; for multi-document jobs it is the first one. Returns undefined
   * for an open job that has not yet received any document.
   */
  get document(): Document | undefined {
    return this._documents[0];
  }

  /** Total impressions across all attached documents; reported as at least 1. */
  get impressions(): number {
    return Math.max(1, this._impressions);
  }

  /** Whether the job is still open for more documents (Send-Document). */
  get isOpen(): boolean {
    return this._open;
  }

  /**
   * The job's current `job-hold-until` keyword (RFC 8011 §5.2.2), or undefined
   * when none was ever specified. Echoed by Get-Job-Attributes.
   */
  get holdUntil(): string | undefined {
    return this._holdUntil;
  }

  /** The job's display name (`job-name`); mutable via Set-Job-Attributes. */
  get jobName(): string {
    return this._jobName;
  }

  /**
   * Set/replace the job's display name (`job-name`). Used by Set-Job-Attributes
   * (RFC 3380 §4.2) on a non-terminal job. An empty/undefined value is ignored.
   */
  setJobName(value: string | undefined): void {
    if (value !== undefined && value.length > 0) this._jobName = value;
  }

  /**
   * The job's `job-priority` (RFC 8011 §5.2.4), or undefined when never set.
   * Echoed by Get-Job-Attributes once a client sets it.
   */
  get jobPriority(): number | undefined {
    return this._jobPriority;
  }

  /**
   * Set the job's `job-priority` (1–100, higher prints sooner). Out-of-range or
   * non-finite values are clamped into [1,100]; the emulator runs jobs to
   * completion synchronously, so priority is recorded/echoed but does not
   * reorder the (already-instant) queue.
   */
  setJobPriority(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value)) return;
    this._jobPriority = Math.min(100, Math.max(1, Math.trunc(value)));
  }

  /** The job's requested `copies` (RFC 8011 §5.2.5), or undefined when unset. */
  get copies(): number | undefined {
    return this._copies;
  }

  /**
   * Set the job's `copies` (≥1). Non-positive/non-finite values are ignored so
   * a malformed write never lowers copies below 1.
   */
  setCopies(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value) || value < 1) return;
    this._copies = Math.trunc(value);
  }

  /**
   * Whether this job is in a non-terminal state (pending / pending-held /
   * processing / processing-stopped) — i.e. a legal Set-Job-Attributes target
   * (RFC 3380 §4.2). A terminal job (completed / canceled / aborted) is not
   * settable and yields client-error-not-possible.
   */
  get isSettable(): boolean {
    const state = this.sm.getState();
    return (
      state !== JobState.COMPLETED &&
      state !== JobState.CANCELED &&
      state !== JobState.ABORTED
    );
  }

  /**
   * Set/replace the `job-hold-until` keyword. Used by Hold-Job to record the
   * value the client held with (so it can be echoed) and by Release-Job to
   * clear an effective hold to `no-hold`.
   */
  setHoldUntil(value: string | undefined): void {
    this._holdUntil = value;
  }

  /**
   * Whether the job is currently held BECAUSE of `job-hold-until` (i.e. it is
   * `pending-held`, not still open for documents, and was held with a holding
   * value). Drives the `job-hold-until-specified` job-state-reason.
   */
  get heldByHoldUntil(): boolean {
    return (
      !this._open &&
      this.sm.getState() === JobState.PENDING_HELD &&
      holdUntilHolds(this._holdUntil)
    );
  }

  /**
   * Append a document to an open multi-document job, accumulating its
   * impressions. No-op contract: only valid while open. Returns true when the
   * document was attached, false when the job is already closed/terminal.
   */
  addDocument(document: Document, impressions?: number): boolean {
    if (!this._open) return false;
    this._documents.push(document);
    this._impressions += Math.max(1, impressions ?? 1);
    return true;
  }

  /**
   * Override the job's total impressions (best-effort). Used after a renderer
   * (e.g. Ghostscript for PDF/PostScript) discovers the true page count, which
   * isn't known until the document is actually rasterized. Ignored for
   * non-positive counts so a failed/empty render never lowers the reported
   * impressions below the 1-page floor.
   */
  setImpressions(impressions: number): void {
    if (impressions > 0) this._impressions = impressions;
  }

  /**
   * Close an open multi-document job (last-document / Close-Job). Releases the
   * held job and runs the emulated print when at least one document was sent;
   * aborts an empty job that was closed with no documents. Idempotent once
   * closed. Returns false if the job was not open.
   */
  close(defer = false): boolean {
    if (!this._open) return false;
    this._open = false;

    if (this._documents.length === 0) {
      // Closed with no document data — abort the empty held job.
      if (this.sm.canTransition(JobEvent.ABORT)) {
        this.sm.transition(JobEvent.ABORT);
      }
      return true;
    }

    // Release the held job to pending. Run it to completion now unless `defer`
    // is set (printer paused) — a deferred job is left `pending` for
    // Resume-Printer's runPendingJobs() to run.
    if (this.sm.canTransition(JobEvent.RELEASE)) {
      this.sm.transition(JobEvent.RELEASE);
    }
    if (!defer) this.process();
    return true;
  }

  /**
   * The number of times this job has run to `completed` (0 before its first
   * completion, 2 after a Restart-Job + second run, …). See `_runs`.
   */
  get runs(): number {
    return this._runs;
  }

  /** Move pending -> processing -> completed in one shot (emulated print). */
  process(): void {
    if (this.sm.canTransition(JobEvent.START_PROCESSING)) {
      this.sm.transition(JobEvent.START_PROCESSING);
    }
    if (this.sm.canTransition(JobEvent.COMPLETE)) {
      this.sm.transition(JobEvent.COMPLETE);
      this._runs += 1;
    }
  }

  /**
   * Hold the job (Hold-Job, 0x000C). Drives a PENDING job to PENDING_HELD via
   * JobEvent.HOLD; a job already PENDING_HELD is left held (idempotent success).
   * Returns false when the job is in a state that cannot be held (processing or
   * terminal), mirroring cancel()'s "false rather than throw" contract.
   */
  hold(): boolean {
    if (this.sm.getState() === JobState.PENDING_HELD) return true;
    if (!this.sm.canTransition(JobEvent.HOLD)) return false;
    this.sm.transition(JobEvent.HOLD);
    return true;
  }

  /**
   * Hold the job with a specific `job-hold-until` keyword (Hold-Job, 0x000C).
   * Records the keyword (echoed by Get-Job-Attributes) and either holds or
   * releases per RFC 8011 §5.2.2:
   *   - `no-hold` ⇒ Hold-Job effectively RELEASES the hold (equivalent to
   *     Release-Job): a held job is released to pending and run; an unheld job
   *     is left running. Returns release()'s result.
   *   - any other value (indefinite / a named time value / unrecognized) ⇒ the
   *     job is held as `pending-held` via hold(). Returns hold()'s result.
   * `defer` is honored on the release path (printer paused → leave pending for
   * runPendingJobs()). Never throws.
   */
  holdWith(value: string | undefined, defer = false): boolean {
    this._holdUntil = value;
    if (!holdUntilHolds(value)) {
      // no-hold (or absence) on Hold-Job means "release the hold".
      return this.release(defer);
    }
    return this.hold();
  }

  /**
   * Release the job (Release-Job, 0x000D). A PENDING_HELD job is released to
   * PENDING (JobEvent.RELEASE) and then run to completion via process(), so a
   * held job actually prints on release — reusing the same pending → processing
   * → completed path Close-Job/last-document uses. A job that is not held is a
   * no-op success (RFC 8011 §4.3.6). Returns false only for a terminal job
   * (completed/canceled/aborted), which cannot be released.
   */
  release(defer = false): boolean {
    const state = this.sm.getState();
    if (
      state === JobState.COMPLETED ||
      state === JobState.CANCELED ||
      state === JobState.ABORTED
    ) {
      return false;
    }
    if (state !== JobState.PENDING_HELD) {
      // Already pending/processing — nothing to release; treat as a no-op.
      return true;
    }
    this.sm.transition(JobEvent.RELEASE);
    // The job is no longer waiting for more documents, and any `job-hold-until`
    // hold has been cleared — the effective value is now `no-hold`.
    this._open = false;
    this._holdUntil = JobHoldUntil.NO_HOLD;
    // Run the emulated print now unless deferred (printer paused) — a deferred
    // job is left `pending` for Resume-Printer's runPendingJobs().
    if (!defer) this.process();
    return true;
  }

  /**
   * Restart the job (Restart-Job, 0x000E) — RFC 8011 §4.3.7. A retained job in
   * a terminal state (completed / canceled / aborted) is re-queued to PENDING
   * (JobEvent.RESTART) and then run again to completion via process(), reusing
   * the same pending → processing → completed path Print-Job/Release-Job use —
   * so a restart is a genuine fresh run (its derived impressions-completed
   * resets to 0 with the PENDING state and `runs` increments on re-completion).
   * `defer` is honored (printer paused → leave the job PENDING for
   * Resume-Printer's runPendingJobs() to run). Returns false — rather than
   * throwing — when the job is NOT terminal (pending / pending-held /
   * processing), which is not a legal Restart-Job target. Mirrors release()'s
   * "false on illegal transition" contract.
   */
  restart(defer = false): boolean {
    if (!this.sm.canTransition(JobEvent.RESTART)) return false;
    this.sm.transition(JobEvent.RESTART);
    // A restarted job is a closed single-shot run again: not open for more
    // documents, and no longer held by any prior `job-hold-until`.
    this._open = false;
    this._holdUntil = JobHoldUntil.NO_HOLD;
    if (!defer) this.process();
    return true;
  }

  /** Cancel the job if its current state allows it. Returns success. */
  cancel(): boolean {
    if (!this.sm.canTransition(JobEvent.CANCEL)) return false;
    this.sm.transition(JobEvent.CANCEL);
    this._open = false;
    return true;
  }
}

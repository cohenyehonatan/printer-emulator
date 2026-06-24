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
import type { JobStateValue } from '../ipp/constants.js';
import type { Document } from '../documents/document.js';

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
}

export class Job {
  readonly id: number;
  readonly printerUri: string;
  readonly jobName: string;
  readonly requestingUserName: string;
  readonly createdAt: Date;
  private readonly _documents: Document[] = [];
  private _impressions: number;
  /** Whether the job is still accepting documents (Create-Job/Send-Document). */
  private _open: boolean;
  private readonly sm: JobStateMachine;

  constructor(init: JobInit) {
    this.id = init.id;
    this.printerUri = init.printerUri;
    this.jobName = init.jobName ?? `job-${init.id}`;
    this.requestingUserName = init.requestingUserName ?? 'anonymous';
    this.createdAt = new Date();
    this._open = init.open ?? false;

    if (init.document) {
      this._documents.push(init.document);
      this._impressions = Math.max(1, init.impressions ?? 1);
    } else {
      // An open job with no documents yet contributes no impressions until one
      // is added; we floor the *reported* impressions to 1 via the getter.
      this._impressions = 0;
    }

    // Multi-document jobs wait held for their documents; single-shot jobs are
    // immediately pending.
    this.sm = new JobStateMachine(
      this._open ? JobState.PENDING_HELD : JobState.PENDING
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
   * Close an open multi-document job (last-document / Close-Job). Releases the
   * held job and runs the emulated print when at least one document was sent;
   * aborts an empty job that was closed with no documents. Idempotent once
   * closed. Returns false if the job was not open.
   */
  close(): boolean {
    if (!this._open) return false;
    this._open = false;

    if (this._documents.length === 0) {
      // Closed with no document data — abort the empty held job.
      if (this.sm.canTransition(JobEvent.ABORT)) {
        this.sm.transition(JobEvent.ABORT);
      }
      return true;
    }

    // Release the held job to pending, then run it to completion.
    if (this.sm.canTransition(JobEvent.RELEASE)) {
      this.sm.transition(JobEvent.RELEASE);
    }
    this.process();
    return true;
  }

  /** Move pending -> processing -> completed in one shot (emulated print). */
  process(): void {
    if (this.sm.canTransition(JobEvent.START_PROCESSING)) {
      this.sm.transition(JobEvent.START_PROCESSING);
    }
    if (this.sm.canTransition(JobEvent.COMPLETE)) {
      this.sm.transition(JobEvent.COMPLETE);
    }
  }

  /** Cancel the job if its current state allows it. Returns success. */
  cancel(): boolean {
    if (!this.sm.canTransition(JobEvent.CANCEL)) return false;
    this.sm.transition(JobEvent.CANCEL);
    this._open = false;
    return true;
  }
}

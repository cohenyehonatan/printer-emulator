/**
 * IPP Job object + lifecycle.
 *
 * A Job (RFC 8011 §4.3) wraps a submitted document, a monotonic job-id, and a
 * JobStateMachine driving the RFC 8011 lifecycle. Transition helpers map the
 * IPP operations (Print-Job, Cancel-Job) onto JobEvents and surface the
 * current numeric job-state for response encoding.
 */

import { JobStateMachine } from './state-machine.js';
import { JobState, JobEvent, jobStateToValue } from './states.js';
import type { JobStateValue } from '../ipp/constants.js';
import type { Document } from '../documents/document.js';

export interface JobInit {
  id: number;
  printerUri: string;
  document: Document;
  jobName?: string;
  requestingUserName?: string;
}

export class Job {
  readonly id: number;
  readonly printerUri: string;
  readonly document: Document;
  readonly jobName: string;
  readonly requestingUserName: string;
  readonly createdAt: Date;
  private readonly sm: JobStateMachine;

  constructor(init: JobInit) {
    this.id = init.id;
    this.printerUri = init.printerUri;
    this.document = init.document;
    this.jobName = init.jobName ?? `job-${init.id}`;
    this.requestingUserName = init.requestingUserName ?? 'anonymous';
    this.createdAt = new Date();
    this.sm = new JobStateMachine(JobState.PENDING);
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
    return true;
  }
}

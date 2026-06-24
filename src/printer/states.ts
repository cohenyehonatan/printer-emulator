/**
 * IPP Job State Machine States and Transitions
 *
 * The RFC 8011 job lifecycle (§5.3.7) modeled as a finite state machine.
 * States and transitions are declared as data so they can be tested and
 * compared against the spec. The string enum values correspond to the
 * numeric job-state keywords in constants.JobStates.
 */

export enum JobState {
  PENDING = 'PENDING',
  PENDING_HELD = 'PENDING_HELD',
  PROCESSING = 'PROCESSING',
  PROCESSING_STOPPED = 'PROCESSING_STOPPED',
  CANCELED = 'CANCELED',
  ABORTED = 'ABORTED',
  COMPLETED = 'COMPLETED',
}

export enum JobEvent {
  HOLD = 'HOLD',
  RELEASE = 'RELEASE',
  START_PROCESSING = 'START_PROCESSING',
  STOP_PROCESSING = 'STOP_PROCESSING',
  RESUME_PROCESSING = 'RESUME_PROCESSING',
  COMPLETE = 'COMPLETE',
  CANCEL = 'CANCEL',
  ABORT = 'ABORT',
}

export interface Transition {
  from: JobState;
  event: JobEvent;
  to: JobState;
}

/**
 * Valid job-state transitions per RFC 8011 §5.3.7 figure.
 *
 *   pending ─start─▶ processing ─complete─▶ completed
 *      │                  │
 *      │                  ├─stop─▶ processing-stopped ─resume─▶ processing
 *      │                  └─cancel/abort─▶ canceled/aborted
 *      ├─hold─▶ pending-held ─release─▶ pending
 *      └─cancel─▶ canceled
 */
export const TRANSITIONS: Transition[] = [
  // Hold / release
  { from: JobState.PENDING, event: JobEvent.HOLD, to: JobState.PENDING_HELD },
  { from: JobState.PENDING_HELD, event: JobEvent.RELEASE, to: JobState.PENDING },

  // Start processing
  { from: JobState.PENDING, event: JobEvent.START_PROCESSING, to: JobState.PROCESSING },

  // Multi-document jobs created via Create-Job begin pending-held (waiting for
  // Send-Document data) and are released to pending on last-document / Close-Job.
  // Abort an empty held job that is closed without any documents.
  { from: JobState.PENDING_HELD, event: JobEvent.ABORT, to: JobState.ABORTED },

  // Processing pause / resume
  { from: JobState.PROCESSING, event: JobEvent.STOP_PROCESSING, to: JobState.PROCESSING_STOPPED },
  { from: JobState.PROCESSING_STOPPED, event: JobEvent.RESUME_PROCESSING, to: JobState.PROCESSING },

  // Completion
  { from: JobState.PROCESSING, event: JobEvent.COMPLETE, to: JobState.COMPLETED },

  // Cancel paths
  { from: JobState.PENDING, event: JobEvent.CANCEL, to: JobState.CANCELED },
  { from: JobState.PENDING_HELD, event: JobEvent.CANCEL, to: JobState.CANCELED },
  { from: JobState.PROCESSING, event: JobEvent.CANCEL, to: JobState.CANCELED },
  { from: JobState.PROCESSING_STOPPED, event: JobEvent.CANCEL, to: JobState.CANCELED },

  // Abort paths
  { from: JobState.PENDING, event: JobEvent.ABORT, to: JobState.ABORTED },
  { from: JobState.PROCESSING, event: JobEvent.ABORT, to: JobState.ABORTED },
  { from: JobState.PROCESSING_STOPPED, event: JobEvent.ABORT, to: JobState.ABORTED },
];

import { JobStates, type JobStateValue } from '../ipp/constants.js';

/** Map a JobState enum to its RFC 8011 numeric job-state value. */
export function jobStateToValue(state: JobState): JobStateValue {
  switch (state) {
    case JobState.PENDING:
      return JobStates.PENDING;
    case JobState.PENDING_HELD:
      return JobStates.PENDING_HELD;
    case JobState.PROCESSING:
      return JobStates.PROCESSING;
    case JobState.PROCESSING_STOPPED:
      return JobStates.PROCESSING_STOPPED;
    case JobState.CANCELED:
      return JobStates.CANCELED;
    case JobState.ABORTED:
      return JobStates.ABORTED;
    case JobState.COMPLETED:
      return JobStates.COMPLETED;
  }
}

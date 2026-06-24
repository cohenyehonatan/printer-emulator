/**
 * Table-driven State Machine for the IPP job lifecycle.
 *
 * Transitions are declared as data in states.ts. This class enforces them and
 * emits events for logging/observation. It is the binary-protocol sibling of
 * the pectab printer's state machine: same table-lookup enforcement pattern,
 * driving JOB state instead of device state.
 */

import { EventEmitter } from 'events';
import { JobState, JobEvent, TRANSITIONS } from './states.js';
import type { Transition } from './states.js';

export class JobStateMachine extends EventEmitter {
  private currentState: JobState;
  private transitionMap: Map<string, Transition>;

  constructor(initialState: JobState = JobState.PENDING) {
    super();
    this.currentState = initialState;

    // Build a lookup map: "fromState:event" -> Transition
    this.transitionMap = new Map();
    for (const t of TRANSITIONS) {
      const key = `${t.from}:${t.event}`;
      this.transitionMap.set(key, t);
    }
  }

  /**
   * Get the current state.
   */
  getState(): JobState {
    return this.currentState;
  }

  /**
   * Attempt a state transition. Returns the new state if valid.
   * Throws if the transition is not allowed.
   */
  transition(event: JobEvent): JobState {
    const key = `${this.currentState}:${event}`;
    const transition = this.transitionMap.get(key);

    if (!transition) {
      throw new InvalidTransitionError(this.currentState, event);
    }

    const previousState = this.currentState;
    this.currentState = transition.to;

    this.emit('transition', {
      from: previousState,
      to: this.currentState,
      event,
    });

    return this.currentState;
  }

  /**
   * Check if a transition is valid without performing it.
   */
  canTransition(event: JobEvent): boolean {
    const key = `${this.currentState}:${event}`;
    return this.transitionMap.has(key);
  }

  /**
   * Get all valid events for the current state.
   */
  getValidEvents(): JobEvent[] {
    const events: JobEvent[] = [];
    for (const [key] of this.transitionMap) {
      const [state, event] = key.split(':');
      if (state === this.currentState) {
        events.push(event as JobEvent);
      }
    }
    return events;
  }

  /**
   * Force-set the state (for testing or error recovery).
   */
  forceState(state: JobState): void {
    const previous = this.currentState;
    this.currentState = state;
    this.emit('transition', {
      from: previous,
      to: state,
      event: 'FORCE_SET',
    });
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly fromState: JobState,
    public readonly event: JobEvent
  ) {
    super(
      `Invalid transition: cannot handle event ${event} in state ${fromState}`
    );
    this.name = 'InvalidTransitionError';
  }
}

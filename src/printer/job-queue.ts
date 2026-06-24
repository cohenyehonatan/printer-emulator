/**
 * In-memory IPP job queue.
 *
 * Owns the monotonic job-id counter and the set of submitted Jobs. The
 * dispatcher/operations enqueue here on Print-Job and look up jobs by id for
 * Get-Job-Attributes / Cancel-Job. Insertion order is preserved for Get-Jobs.
 */

import { Job, type JobInit } from './job.js';

export class JobQueue {
  private nextId = 1;
  private readonly jobs: Job[] = [];

  /** Create + enqueue a new Job, assigning the next job-id. */
  enqueue(init: Omit<JobInit, 'id'>): Job {
    const job = new Job({ ...init, id: this.nextId++ });
    this.jobs.push(job);
    return job;
  }

  /** Look up a job by id. */
  get(id: number): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** All jobs in submission order. */
  list(): readonly Job[] {
    return this.jobs;
  }

  /** Number of jobs currently tracked. */
  size(): number {
    return this.jobs.length;
  }

  /**
   * Remove ALL jobs from the queue — including retained terminal
   * (completed/canceled/aborted) jobs. Backs Purge-Jobs (0x0012): the admin
   * "empty the queue entirely" operation. The job-id counter is intentionally
   * NOT reset, so ids stay monotonic across a purge. Returns the number of jobs
   * removed.
   */
  clear(): number {
    const removed = this.jobs.length;
    this.jobs.length = 0;
    return removed;
  }
}

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
}

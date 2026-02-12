import type { QueuedJob } from "./types.js";

type JobHandler = (job: QueuedJob) => Promise<void>;

export class JobQueue {
  private queue: QueuedJob[] = [];
  private running = 0;
  private maxConcurrent: number;
  private handler: JobHandler;

  constructor(maxConcurrent: number, handler: JobHandler) {
    this.maxConcurrent = maxConcurrent;
    this.handler = handler;
  }

  enqueue(job: QueuedJob): void {
    this.queue.push(job);
    console.log(
      `[queue] Enqueued job for ${job.owner}/${job.repo}#${job.issueNumber} (queue size: ${this.queue.length}, running: ${this.running})`
    );
    this.processNext();
  }

  get stats() {
    return {
      queued: this.queue.length,
      running: this.running,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private processNext(): void {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.running++;
    console.log(
      `[queue] Starting job for ${job.owner}/${job.repo}#${job.issueNumber} (running: ${this.running})`
    );

    this.handler(job)
      .catch((err) => {
        console.error(
          `[queue] Job failed for ${job.owner}/${job.repo}#${job.issueNumber}:`,
          err
        );
      })
      .finally(() => {
        this.running--;
        console.log(
          `[queue] Job finished for ${job.owner}/${job.repo}#${job.issueNumber} (running: ${this.running})`
        );
        this.processNext();
      });
  }
}

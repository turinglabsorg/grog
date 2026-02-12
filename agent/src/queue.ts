import type { QueuedJob } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("queue");

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
    log.info(`Enqueued ${job.owner}/${job.repo}#${job.issueNumber} (queue: ${this.queue.length}, running: ${this.running})`);
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
    log.info(`Starting ${job.owner}/${job.repo}#${job.issueNumber} (running: ${this.running})`);

    this.handler(job)
      .catch((err) => {
        log.error(`Job failed for ${job.owner}/${job.repo}#${job.issueNumber}: ${(err as Error).message ?? err}`);
      })
      .finally(() => {
        this.running--;
        log.info(`Job finished for ${job.owner}/${job.repo}#${job.issueNumber} (running: ${this.running})`);
        this.processNext();
      });
  }
}

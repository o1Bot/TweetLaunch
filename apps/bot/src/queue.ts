import { Queue, Worker, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { logger } from "@o1bot/shared";
import type { XMention } from "@o1bot/x";

/**
 * Work queue between the X listener and the pipeline. One job per mention,
 * keyed by tweet id so a re-fetched mention is never queued twice. Jobs run
 * one at a time: launches touch a nonce per wallet and the parser has rate
 * limits, so parallelism would only add failure modes.
 *
 * Memory driver: in-process, for tests, dry runs and single-instance
 * deployments. Redis driver (BullMQ): survives restarts and lets the
 * listener and worker live in different processes.
 */

export type LaunchJob = { mention: XMention };
export type JobHandler = (job: LaunchJob) => Promise<void>;
export type EnqueueResult = "queued" | "duplicate";

export interface JobQueue {
  enqueue(job: LaunchJob): Promise<EnqueueResult>;
  /** Attach the worker. Jobs queued before this call wait for it. */
  start(handler: JobHandler): void;
  /** Resolve once every queued job has finished (memory) or the worker is idle (redis). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export class MemoryQueue implements JobQueue {
  private seen = new Set<string>();
  private pending: LaunchJob[] = [];
  private handler: JobHandler | null = null;
  private tail: Promise<void> = Promise.resolve();

  async enqueue(job: LaunchJob): Promise<EnqueueResult> {
    if (this.seen.has(job.mention.id)) return "duplicate";
    this.seen.add(job.mention.id);
    if (this.handler) this.schedule(job);
    else this.pending.push(job);
    return "queued";
  }

  start(handler: JobHandler) {
    this.handler = handler;
    for (const job of this.pending.splice(0)) this.schedule(job);
  }

  private schedule(job: LaunchJob) {
    const handler = this.handler!;
    this.tail = this.tail.then(() => handler(job)).catch((err) => logger.error({ err, tweetId: job.mention.id }, "job failed"));
  }

  async drain() {
    // Jobs may enqueue more jobs while running; loop until the tail settles.
    let current: Promise<void>;
    do {
      current = this.tail;
      await current;
    } while (current !== this.tail);
  }

  async close() {
    await this.drain();
  }
}

const QUEUE_NAME = "o1bot-launches";

export class BullQueue implements JobQueue {
  private readonly connection: IORedis;
  private readonly queue: Queue<LaunchJob>;
  private worker: Worker<LaunchJob> | null = null;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<LaunchJob>(QUEUE_NAME, { connection: this.connection });
  }

  private jobId(mention: XMention) {
    return `mention-${mention.id}`;
  }

  async enqueue(job: LaunchJob): Promise<EnqueueResult> {
    const jobId = this.jobId(job.mention);
    if (await this.queue.getJob(jobId)) return "duplicate";
    // No automatic retries: a launch that failed after signing must never be re-run blindly.
    const opts: JobsOptions = { jobId, attempts: 1, removeOnComplete: 2000, removeOnFail: 5000 };
    await this.queue.add("mention", job, opts);
    return "queued";
  }

  start(handler: JobHandler) {
    if (this.worker) return;
    this.worker = new Worker<LaunchJob>(QUEUE_NAME, async (job) => handler(job.data), { connection: this.connection, concurrency: 1 });
    this.worker.on("failed", (job, err) => logger.error({ err, tweetId: job?.data.mention.id }, "job failed"));
  }

  async drain() {
    // Wait until the queue has no waiting or active jobs.
    for (;;) {
      const counts = await this.queue.getJobCounts("waiting", "active", "delayed");
      if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}

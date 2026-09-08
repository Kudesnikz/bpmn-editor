import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { AppError } from '../errors.js';
import type { JsonJob } from './jobs.js';

interface Pending {
  job: JsonJob;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
}

export class JsonWorkerPool {
  private queue: Pending[] = [];
  private active?: { worker: Worker; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;

  constructor(private readonly timeoutMs = 15000, private readonly queueLimit = 4) {}

  run(job: JsonJob): Promise<any> {
    if (this.closed) return Promise.reject(new AppError(503, 'SERVER_STOPPING', 'Server is stopping'));
    if (this.active && this.queue.length >= this.queueLimit) return Promise.reject(new AppError(503, 'JSON_QUEUE_FULL', 'JSON processing queue is full'));
    return new Promise((resolve, reject) => {
      const pending: Pending = { job, resolve, reject, deadline: Date.now() + this.timeoutMs, timer: setTimeout(() => {
        const index = this.queue.indexOf(pending);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(new AppError(503, 'JSON_QUEUE_TIMEOUT', 'JSON job waited too long'));
        }
      }, this.timeoutMs) };
      this.queue.push(pending);
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.active || this.closed) return;
    const pending = this.queue.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    const built = new URL('./worker-entry.js', import.meta.url);
    const source = new URL('./worker-entry.ts', import.meta.url);
    let worker: Worker;
    try {
      worker = existsSync(built) ? new Worker(built, { workerData: pending.job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } })
        : new Worker(`require('tsx/esm/api').tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}).catch(() => process.exit(1))`, { eval: true, workerData: pending.job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
    } catch {
      pending.reject(new AppError(500, 'JSON_WORKER_FAILED', 'Could not start JSON worker'));
      this.startNext(); return;
    }
    let settled = false;
    const finish = (error?: Error, value?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(this.active?.timer);
      // Keep the slot occupied until termination completes, including after a timeout.
      void worker.terminate().finally(() => {
        this.active = undefined;
        if (error) pending.reject(error); else pending.resolve(value);
        this.startNext();
      });
    };
    const timer = setTimeout(() => finish(new AppError(503, 'JSON_PROCESSING_TIMEOUT', 'JSON processing exceeded its deadline')), Math.max(1, pending.deadline - Date.now()));
    this.active = { worker, reject: error => finish(error), timer };
    worker.once('message', message => message.ok ? finish(undefined, message.result) : finish(new AppError(message.error.status, message.error.code, message.error.message, message.error.details)));
    worker.once('error', () => finish(new AppError(500, 'JSON_WORKER_FAILED', 'JSON worker failed')));
    worker.once('exit', () => { if (!settled) finish(new AppError(500, 'JSON_WORKER_FAILED', 'JSON worker exited before completing')); });
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new AppError(503, 'SERVER_STOPPING', 'Server is stopping');
    for (const pending of this.queue.splice(0)) { clearTimeout(pending.timer); pending.reject(error); }
    if (this.active) {
      const active = this.active;
      active.reject(error);
      await active.worker.terminate();
    }
  }
}

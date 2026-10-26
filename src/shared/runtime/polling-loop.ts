import type { Logger } from "../observability/logger";

export interface PollingLoopOptions {
  name: string;
  tick: (signal: AbortSignal) => Promise<boolean>;
  idleMs: number;
  errorBackoffMs?: number;
  logger: Logger;
}

export class PollingLoop {
  private running = false;
  private abort = new AbortController();
  private loopPromise?: Promise<void>;

  constructor(private readonly options: PollingLoopOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
    this.options.logger.info("worker started", { worker: this.options.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loopPromise;
    this.options.logger.info("worker stopped", { worker: this.options.name });
  }

  private async loop(): Promise<void> {
    const { tick, idleMs, errorBackoffMs = 1_000, logger, name } = this.options;
    while (this.running) {
      let didWork = false;
      try {
        didWork = await tick(this.abort.signal);
      } catch (error) {
        if (!this.running && isAbort(error)) break;
        logger.error("worker iteration failed", { worker: name, error });
        await sleep(errorBackoffMs, this.abort.signal);
        continue;
      }
      if (!didWork && this.running) await sleep(idleMs, this.abort.signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

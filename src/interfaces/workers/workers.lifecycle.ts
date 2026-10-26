import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "@/config";
import { LOGGER, type Logger } from "@/shared/observability/logger";
import { PollingLoop } from "@/shared/runtime/polling-loop";
import { OutboxRelay } from "@/wagering/application/outbox-relay";
import { ProcessPendingReferences } from "@/wagering/application/process-pending-references";
import { WagerTransactionConsumer } from "../sqs/wager-transaction-consumer";

const SHUTDOWN_TIMEOUT_MS = 20_000;
const OUTBOX_STATE_EVERY_MS = 5_000;

@Injectable()
export class WorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loops: { name: string; loop: PollingLoop }[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WagerTransactionConsumer) private readonly consumer: WagerTransactionConsumer,
    @Inject(ProcessPendingReferences) private readonly references: ProcessPendingReferences,
    @Inject(OutboxRelay) private readonly relay: OutboxRelay,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const { roles } = this.config;
    if (roles.consumer) {
      this.add("sqs-consumer", 100, async (signal) => (await this.consumer.pollOnce(signal)) > 0);
    }
    if (roles.referenceWorker) {
      this.add("pending-reference-worker", 1_000, async (signal) => (await this.references.processBatch(20, signal)) > 0);
    }
    if (roles.outboxPublisher) {
      let lastStateReport = 0;
      this.add("outbox-publisher", 500, async () => {
        const handled = await this.relay.relayOnce();
        if (Date.now() - lastStateReport >= OUTBOX_STATE_EVERY_MS) {
          lastStateReport = Date.now();
          await this.relay.reportState();
        }
        return handled > 0;
      });
    }
    for (const { loop } of this.loops) loop.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info("draining workers", { signal, workers: this.loops.map((l) => l.name) });
    const drain = (async () => {
      for (const { loop } of this.loops) await loop.stop();
    })();
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS));
    if ((await Promise.race([drain, timeout])) === "timeout") {
      this.logger.error("workers did not drain in time; unacked messages will be redelivered", {
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
    }
  }

  private add(name: string, idleMs: number, tick: (signal: AbortSignal) => Promise<boolean>): void {
    this.loops.push({ name, loop: new PollingLoop({ name, tick, idleMs, logger: this.logger.child({ worker: name }) }) });
  }
}

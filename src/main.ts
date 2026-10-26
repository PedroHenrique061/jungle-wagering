import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { LoggerService } from "@nestjs/common";
import { AppModule, configureApp } from "./app.module";
import { loadConfig } from "./config";
import { JsonLogger, type Logger } from "./shared/observability/logger";

class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.info(String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error(String(message), { context, trace });
  }
  warn(message: unknown, context?: string) {
    this.logger.warn(String(message), { context });
  }
  debug(message: unknown, context?: string) {
    this.logger.debug(String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    this.logger.debug(String(message), { context });
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger({ service: "jungle-wagering", instanceId: config.instanceId });

  const app = await NestFactory.create(AppModule.register({ config, logger }), {
    logger: new NestLoggerAdapter(logger),
  });
  configureApp(app);
  await app.listen(config.port);
  logger.info("http server listening", { port: config.port });
}

bootstrap().catch((error: unknown) => {
  new JsonLogger({ service: "jungle-wagering" }).error("bootstrap failed", { error });
  process.exit(1);
});

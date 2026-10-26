export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED_KEY = /payload|body|authorization|password|secret|token|cookie|amount|balance|money|initialBalance/i;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) {
    const err: LogFields = { name: value.name, message: value.message };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) err.code = code;
    return err;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: LogFields = {};
  for (const [key, v] of Object.entries(value as LogFields)) {
    out[key] = REDACTED_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export class JsonLogger implements Logger {
  constructor(
    private readonly context: LogFields = {},
    private readonly minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info",
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({ ...this.context, ...fields }, this.minLevel, this.sink);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVELS[level] < (LEVELS[this.minLevel] ?? LEVELS.info)) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      ...(redact({ ...this.context, ...fields }) as LogFields),
    };
    try {
      this.sink(JSON.stringify(entry));
    } catch {
      this.sink(JSON.stringify({ time: entry.time, level, message, logError: "unserializable fields" }));
    }
  }
}

export const LOGGER = Symbol("Logger");

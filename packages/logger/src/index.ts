export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  bindings?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions): Logger {
  return new JsonLogger(options.name, options.level ?? resolveDefaultLevel(), options.bindings ?? {});
}

class JsonLogger implements Logger {
  constructor(
    private readonly name: string,
    private readonly level: LogLevel,
    private readonly bindings: Record<string, unknown>,
  ) {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(this.name, this.level, { ...this.bindings, ...bindings });
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (levelOrder[level] < levelOrder[this.level]) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      message,
      ...this.bindings,
      ...meta,
    };

    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

function resolveDefaultLevel(): LogLevel {
  const raw = process.env.AGENT_VOICE_LOG_LEVEL;

  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }

  return 'info';
}

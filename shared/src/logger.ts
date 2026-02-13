type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const level: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";
const minLevel = LEVELS[level] ?? 1;
const jsonMode = process.env.LOG_FORMAT === "json";

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  jobId?: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry): void {
  if (LEVELS[entry.level] < minLevel) return;

  if (jsonMode) {
    const stream = entry.level === "error" || entry.level === "warn" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + "\n");
    return;
  }

  // Human-readable format for dev
  const prefix = `[${entry.component}]`;
  const jobTag = entry.jobId ? ` (${entry.jobId})` : "";
  const text = `${prefix}${jobTag} ${entry.msg}`;

  switch (entry.level) {
    case "debug":
      console.debug(text);
      break;
    case "info":
      console.log(text);
      break;
    case "warn":
      console.warn(text);
      break;
    case "error":
      console.error(text);
      break;
  }
}

export function createLogger(component: string, jobId?: string) {
  function makeEntry(lvl: LogLevel, msg: string, extra?: Record<string, unknown>): LogEntry {
    return {
      ts: new Date().toISOString(),
      level: lvl,
      component,
      msg,
      ...(jobId ? { jobId } : {}),
      ...extra,
    };
  }

  return {
    debug: (msg: string, extra?: Record<string, unknown>) => emit(makeEntry("debug", msg, extra)),
    info: (msg: string, extra?: Record<string, unknown>) => emit(makeEntry("info", msg, extra)),
    warn: (msg: string, extra?: Record<string, unknown>) => emit(makeEntry("warn", msg, extra)),
    error: (msg: string, extra?: Record<string, unknown>) => emit(makeEntry("error", msg, extra)),
    child: (childJobId: string) => createLogger(component, childJobId),
  };
}

export type Logger = ReturnType<typeof createLogger>;

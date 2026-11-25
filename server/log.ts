type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? order.info;

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold) return;
  const suffix = fields ? " " + JSON.stringify(fields) : "";
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};

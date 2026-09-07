import pino from "pino";

/**
 * One JSON logger for every process. Pretty output is opt-in via LOG_PRETTY
 * because pino transports spawn a worker thread, which Next.js route handlers
 * do not always tolerate.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "o1bot" },
  ...(process.env.LOG_PRETTY === "true"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
    : {}),
});

export type Logger = typeof logger;

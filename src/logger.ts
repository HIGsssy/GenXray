import pino from "pino";
import { config } from "./config.js";

/** Redact sensitive values from logs. */
const REDACTED_KEYS = ["DISCORD_TOKEN", "token", "authorization", "password", "secret"];

export const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: REDACTED_KEYS,
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.transport({
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      ignore: "pid,hostname",
    },
  }),
);

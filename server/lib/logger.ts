import pino from "pino";
import { config, isTest } from "../config.js";

/** Structured logs. Secrets and tokens are redacted by path, so they cannot be logged by accident. */
export const log = pino({
  level: isTest ? "silent" : config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization", "req.headers.cookie", 'req.headers["x-pine-tool-secret"]', 'req.headers["x-api-key"]',
      "*.password", "*.apiKey", "*.api_key", "*.secret", "*.token", "*.webhookSecret", "*.credentials",
    ],
    censor: "[redacted]",
  },
});

import { config } from "../config.js";
import { purgeOldJobs } from "../db/purge.js";
import { logger } from "../logger.js";

let isRunning = false;

async function runPurge(): Promise<void> {
  if (isRunning) {
    logger.debug("Purge already running, skipping this tick");
    return;
  }
  isRunning = true;
  try {
    const maxAgeMs = config.purge.maxAgeHours * 60 * 60 * 1000;
    purgeOldJobs(maxAgeMs);
  } catch (err) {
    logger.error({ err }, "Purge scheduler: unhandled error during purge");
  } finally {
    isRunning = false;
  }
}

export function startPurgeScheduler(): void {
  const intervalMs = config.purge.intervalHours * 60 * 60 * 1000;
  const maxAgeHours = config.purge.maxAgeHours;

  logger.info(
    { intervalHours: config.purge.intervalHours, maxAgeHours },
    "Purge scheduler started"
  );

  // Initial purge after 60 seconds to clear any backlog from a previous run
  setTimeout(() => void runPurge(), 60_000);

  // Recurring purge on the configured interval
  setInterval(() => void runPurge(), intervalMs);
}

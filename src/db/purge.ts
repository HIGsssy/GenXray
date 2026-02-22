import { getDb } from "./database.js";
import { logger } from "../logger.js";

export interface PurgeResult {
  jobsDeleted: number;
  upscaleJobsDeleted: number;
}

/**
 * Deletes completed and failed job records older than `maxAgeMs` milliseconds.
 * `upscale_jobs` rows are removed first to satisfy the FK constraint.
 * Runs in a single transaction so the DB is never left in a partial state.
 */
export function purgeOldJobs(maxAgeMs: number): PurgeResult {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;

  const purge = db.transaction(() => {
    const upscaleResult = db
      .prepare(
        `DELETE FROM upscale_jobs
         WHERE status IN ('completed', 'failed')
           AND created_at < ?`
      )
      .run(cutoff);

    const jobsResult = db
      .prepare(
        `DELETE FROM jobs
         WHERE status IN ('completed', 'failed')
           AND created_at < ?`
      )
      .run(cutoff);

    return {
      jobsDeleted: jobsResult.changes,
      upscaleJobsDeleted: upscaleResult.changes,
    };
  });

  const result = purge() as PurgeResult;

  logger.info(
    { jobsDeleted: result.jobsDeleted, upscaleJobsDeleted: result.upscaleJobsDeleted, cutoff },
    "Purge complete"
  );

  return result;
}

# DB & Image Purge Implementation Plan

**Goal:** Automatically remove old completed/failed job records from the database and their associated output image files from disk, keeping storage usage bounded. The default retention window is 48 hours, configurable via an environment variable. A manual trigger is also available via a bot owner command.

---

## Decisions

- Only `completed` and `failed` jobs are eligible for purge — `queued` and `processing` rows are never touched.
- Both `jobs` and `upscale_jobs` tables are purged; `upscale_jobs` rows are deleted first to satisfy the foreign-key constraint (`source_job_id` references `jobs.id`).
- Output image files listed in `output_images` (JSON array of filenames) are deleted from disk before the DB rows are removed.
- Purge runs automatically on a configurable interval (default: every 6 hours) via a simple `setInterval` scheduler started at bot startup.
- A bot-owner-only `/purge` slash command triggers an immediate purge and reports how many rows and files were removed.
- All purge activity is written to the existing logger at `info` level; individual file-deletion failures are logged as `warn` but do not abort the purge.
- The retention age is controlled by `PURGE_MAX_AGE_HOURS` env var (default `48`).

---

## Step-by-Step Implementation

### 1. Config — `src/config.ts`

Add two optional env vars to the Zod schema:

```ts
PURGE_MAX_AGE_HOURS:      z.coerce.number().int().positive().default(48),
PURGE_INTERVAL_HOURS:     z.coerce.number().int().positive().default(6),
```

---

### 2. DB layer — new `src/db/purge.ts`

```ts
export interface PurgeResult {
  jobsDeleted: number;
  upscaleJobsDeleted: number;
  filesDeleted: number;
  fileErrors: number;
}

export async function purgeOldJobs(maxAgeMs: number): Promise<PurgeResult>
```

Algorithm:

1. Calculate the cutoff timestamp: `const cutoff = Date.now() - maxAgeMs`
2. **Collect eligible rows** (do not delete yet):
   ```sql
   SELECT id, output_images FROM upscale_jobs
   WHERE status IN ('completed', 'failed')
     AND created_at < :cutoff
   ```
   ```sql
   SELECT id, output_images FROM jobs
   WHERE status IN ('completed', 'failed')
     AND created_at < :cutoff
   ```
3. **Delete image files from disk** for all collected rows (both tables). Parse each row's `output_images` JSON array, resolve each filename against the configured output directory (`data/output/` or whatever `OUTPUT_DIR` resolves to), and call `fs.unlink()`. Count successes and failures.
4. **Delete upscale_jobs rows** first (FK constraint):
   ```sql
   DELETE FROM upscale_jobs
   WHERE status IN ('completed', 'failed')
     AND created_at < :cutoff
   ```
5. **Delete jobs rows**:
   ```sql
   DELETE FROM jobs
   WHERE status IN ('completed', 'failed')
     AND created_at < :cutoff
   ```
6. Return `PurgeResult` with counts.

Wrap steps 4–5 in a single SQLite transaction so the DB is never left in a partial state.

---

### 3. Purge scheduler — new `src/queue/purgeScheduler.ts`

```ts
export function startPurgeScheduler(): void
```

- Reads `config.PURGE_MAX_AGE_HOURS` and `config.PURGE_INTERVAL_HOURS`.
- Calls `purgeOldJobs()` once at startup (after a short delay, e.g. 60 seconds) to clean up any backlog from a previous run.
- Then schedules `setInterval(() => purgeOldJobs(...), intervalMs)`.
- Logs interval and retention age at `info` on startup.
- Logs a summary line on each run: `Purge complete: X jobs, Y upscale jobs, Z files removed (W file errors)`.

---

### 4. Boot wiring — `src/index.ts`

Call `startPurgeScheduler()` during bot startup, after the DB is confirmed reachable and before the Discord client logs in.

---

### 5. `/purge` slash command — new `src/bot/commands/purge.ts`

Owner-only (checked via `interaction.user.id === config.OWNER_ID`).

Options:

| Option | Type | Required | Description |
|---|---|---|---|
| `hours` | integer | No | Override retention age for this run only (default: `PURGE_MAX_AGE_HOURS`) |

Behaviour:
1. Defer the interaction as ephemeral.
2. Call `purgeOldJobs(hoursMs)`.
3. Reply with a summary embed:
   - Green if successful.
   - Lists jobs deleted, upscale jobs deleted, files deleted, and any file errors.
   - Shows the age cutoff used.

---

### 6. Deploy commands — `src/scripts/deployCommands.ts`

Register the new `/purge` command alongside existing commands.

---

## Edge Cases & Safety

| Scenario | Handling |
|---|---|
| File already missing from disk | `ENOENT` caught and counted as a file error, purge continues |
| Job currently being processed at purge time | `status` check (`IN ('completed', 'failed')`) ensures in-flight rows are never touched |
| Very large backlog on first run | SQL `DELETE` with `LIMIT` batching can be added if performance is a concern; deferred to implementation |
| `output_images` is NULL or malformed JSON | Wrap parse in try/catch, skip file deletion for that row, log a warning |
| Purge interval overlaps with previous run | Wrap the scheduler callback so a second invocation does not start until the first completes (use a boolean `isRunning` guard) |

---

## Data Flow Summary

```
setInterval / /purge command
        │
        ▼
purgeOldJobs(maxAgeMs)
        │
        ├─ SELECT eligible upscale_jobs + jobs rows
        │
        ├─ fs.unlink() each output image file
        │         │
        │    ENOENT / other error → log warn, increment fileErrors
        │
        ├─ BEGIN TRANSACTION
        │    DELETE FROM upscale_jobs WHERE ... AND created_at < cutoff
        │    DELETE FROM jobs         WHERE ... AND created_at < cutoff
        └─ COMMIT
                │
                ▼
        log summary / return PurgeResult
```

---

## Verification Checklist

- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] Setting `PURGE_MAX_AGE_HOURS=0` purges all completed/failed rows immediately (useful for testing)
- [ ] `queued` and `processing` rows are never deleted regardless of age
- [ ] Output image files are removed from disk after a purge
- [ ] Missing files do not abort the purge (ENOENT handled gracefully)
- [ ] `upscale_jobs` rows are deleted before their parent `jobs` rows (no FK violation)
- [ ] `/purge` with no options uses the configured default age
- [ ] `/purge hours:1` uses 1 hour as the cutoff for that run only
- [ ] Non-owner users receive an ephemeral "Unauthorised" response for `/purge`
- [ ] Purge scheduler logs its interval and retention age on startup
- [ ] Scheduler does not start a second concurrent purge if the previous one is still running
- [ ] `PURGE_INTERVAL_HOURS` env var correctly sets the auto-run cadence
- [ ] Bot startup triggers an initial purge after the 60-second delay

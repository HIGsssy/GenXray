import { getDb } from "./database.js";
import type { JobRow, JobParams, JobStatus, ImageSize } from "../queue/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToJob(row: Record<string, unknown>): JobRow {
  return {
    id: row.id as string,
    userId: row.discord_user_id as string,
    guildId: row.discord_guild_id as string,
    channelId: row.discord_channel_id as string,
    discordMessageId: (row.discord_message_id as string | null) ?? null,
    status: row.status as JobStatus,
    model: row.model as string,
    sampler: row.sampler as string,
    scheduler: row.scheduler as string,
    steps: row.steps as number,
    cfg: row.cfg as number,
    seed: (row.seed as number) ?? 0,
    size: ((row.size as string) ?? "portrait") as ImageSize,
    positivePrompt: row.positive_prompt as string,
    negativePrompt: row.negative_prompt as string,
    comfyPromptId: (row.comfy_prompt_id as string | null) ?? null,
    outputImages: row.output_images ? JSON.parse(row.output_images as string) : null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    completedAt: (row.completed_at as number | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function insertJob(id: string, params: JobParams): JobRow {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO jobs (
      id, discord_user_id, discord_guild_id, discord_channel_id,
      status, model, sampler, scheduler, steps, cfg, seed, size,
      positive_prompt, negative_prompt, created_at
    ) VALUES (
      ?, ?, ?, ?,
      'queued', ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    id,
    params.userId,
    params.guildId,
    params.channelId,
    params.model,
    params.sampler,
    params.scheduler,
    params.steps,
    params.cfg,
    params.seed,
    params.size,
    params.positivePrompt,
    params.negativePrompt,
    now,
  );
  return getJobOrThrow(id);
}

export function setJobRunning(id: string, comfyPromptId: string): void {
  getDb().prepare(`
    UPDATE jobs SET status = 'running', comfy_prompt_id = ?, started_at = ? WHERE id = ?
  `).run(comfyPromptId, Date.now(), id);
}

export function setJobCompleted(id: string, outputImages: string[]): void {
  getDb().prepare(`
    UPDATE jobs SET status = 'completed', output_images = ?, completed_at = ? WHERE id = ?
  `).run(JSON.stringify(outputImages), Date.now(), id);
}

export function setJobFailed(id: string, errorMessage: string): void {
  getDb().prepare(`
    UPDATE jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
  `).run(errorMessage, Date.now(), id);
}

export function setJobMessageId(id: string, messageId: string): void {
  getDb().prepare(`UPDATE jobs SET discord_message_id = ? WHERE id = ?`).run(messageId, id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getJobOrThrow(id: string): JobRow {
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Job not found: ${id}`);
  return rowToJob(row);
}

export function getJobsByStatus(status: JobStatus): JobRow[] {
  const rows = getDb().prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC").all(status) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function countQueuedBefore(id: string): number {
  const job = getJobOrThrow(id);
  const result = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'queued' AND created_at < ?",
  ).get(job.createdAt) as { cnt: number };
  return result.cnt;
}

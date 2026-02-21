import { getDb } from "./database.js";
import type { UpscaleJobRow, UpscaleJobParams, JobStatus } from "../queue/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToUpscaleJob(row: Record<string, unknown>): UpscaleJobRow {
  return {
    id: row.id as string,
    sourceJobId: row.source_job_id as string,
    sourceImageFilename: row.source_image_filename as string,
    userId: row.user_id as string,
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    discordMessageId: (row.discord_message_id as string | null) ?? null,
    status: row.status as JobStatus,
    model: row.model as string,
    positivePrompt: row.positive_prompt as string,
    negativePrompt: row.negative_prompt as string,
    upscaleModel: row.upscale_model as string,
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

export function insertUpscaleJob(id: string, params: UpscaleJobParams): UpscaleJobRow {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO upscale_jobs (
      id, source_job_id, source_image_filename,
      user_id, guild_id, channel_id,
      model, positive_prompt, negative_prompt, upscale_model,
      status, created_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      'queued', ?
    )
  `).run(
    id,
    params.sourceJobId,
    params.sourceImageFilename,
    params.userId,
    params.guildId,
    params.channelId,
    params.model,
    params.positivePrompt,
    params.negativePrompt,
    params.upscaleModel,
    now,
  );
  return getUpscaleJobOrThrow(id);
}

export function setUpscaleJobRunning(id: string, comfyPromptId: string): void {
  getDb().prepare(`
    UPDATE upscale_jobs SET status = 'running', comfy_prompt_id = ?, started_at = ? WHERE id = ?
  `).run(comfyPromptId, Date.now(), id);
}

export function setUpscaleJobCompleted(id: string, outputImages: string[]): void {
  getDb().prepare(`
    UPDATE upscale_jobs SET status = 'completed', output_images = ?, completed_at = ? WHERE id = ?
  `).run(JSON.stringify(outputImages), Date.now(), id);
}

export function setUpscaleJobFailed(id: string, errorMessage: string): void {
  getDb().prepare(`
    UPDATE upscale_jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?
  `).run(errorMessage, Date.now(), id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getUpscaleJobOrThrow(id: string): UpscaleJobRow {
  const row = getDb().prepare("SELECT * FROM upscale_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Upscale job not found: ${id}`);
  return rowToUpscaleJob(row);
}

export function countUpscaleQueuedBefore(id: string): number {
  const job = getUpscaleJobOrThrow(id);
  const result = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM upscale_jobs WHERE status = 'queued' AND created_at < ?",
  ).get(job.createdAt) as { cnt: number };
  return result.cnt;
}

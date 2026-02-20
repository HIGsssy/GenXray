// ---------------------------------------------------------------------------
// Core domain types shared across queue, DB, and binder modules
// ---------------------------------------------------------------------------

export interface JobParams {
  userId: string;
  guildId: string;
  channelId: string;
  model: string;
  sampler: string;
  scheduler: string;
  steps: number; // 1–150
  cfg: number; // 1.0–30.0
  positivePrompt: string;
  negativePrompt: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobRow extends JobParams {
  id: string; // UUIDv4
  discordMessageId: string | null;
  status: JobStatus;
  comfyPromptId: string | null;
  outputImages: string[] | null;
  errorMessage: string | null;
  createdAt: number; // Unix ms
  startedAt: number | null;
  completedAt: number | null;
}

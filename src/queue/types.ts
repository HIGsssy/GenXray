// ---------------------------------------------------------------------------
// Core domain types shared across queue, DB, and binder modules
// ---------------------------------------------------------------------------

export type ImageSize = "portrait" | "square" | "landscape";
export type UpscaleWorkflow = "ultimate" | "simple";

export interface LoraParam {
  name: string;       // filename e.g. "my_lora_v1.safetensors"
  strength: number;   // 0.1 – 2.0, default 1.0
  triggerWords: string[]; // fetched from CivitAI; stripped before DB persist
}

export interface JobParams {
  userId: string;
  guildId: string;
  channelId: string;
  model: string;
  sampler: string;
  scheduler: string;
  steps: number; // 1–150
  cfg: number;   // 1.0–30.0
  seed: number;  // 0–4294967295
  size: ImageSize;
  positivePrompt: string;
  negativePrompt: string;
  loras: (LoraParam | null)[]; // always length 4; null = empty slot
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface UpscaleJobParams {
  userId: string;
  guildId: string;
  channelId: string;
  sourceJobId: string;
  sourceImageFilename: string;
  model: string;
  positivePrompt: string;
  negativePrompt: string;
  upscaleModel: string;
}

export interface UpscaleJobRow extends UpscaleJobParams {
  id: string;
  discordMessageId: string | null;
  status: JobStatus;
  comfyPromptId: string | null;
  outputImages: string[] | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

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

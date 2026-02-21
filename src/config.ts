import { z } from "zod";
import { readFileSync } from "node:fs";

// Load .env manually so the module is self-contained (no dotenv dependency).
// In production the shell / systemd injects variables directly.
function loadDotenv(): void {
  try {
    const raw = readFileSync(".env", "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      // Strip inline comments (anything after unquoted ' #' or ' #')
      const rawValue = trimmed.slice(eqIdx + 1).trim();
      const value = rawValue.replace(/\s+#.*$/, "").trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; production uses real env vars
  }
}

loadDotenv();

const ConfigSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  ALLOWED_CHANNEL_IDS: z.string().min(1, "ALLOWED_CHANNEL_IDS is required"),
  COMFY_BASE_URL: z.string().url("COMFY_BASE_URL must be a valid URL").default("http://127.0.0.1:8188"),
  COMFY_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
  DB_PATH: z.string().default("./data/comfygen.db"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DEFAULT_NEGATIVE_PROMPT: z.string().default(""),
  UPSCALE_MODEL: z.string().default("RealESRGAN_x4plus_anime_6B.pth"),
  UPSCALE_WORKFLOW: z.enum(["ultimate", "simple"]).default("ultimate"),
  UPSCALE_ENABLED: z.preprocess((v) => v !== "false" && v !== "0" && v !== "", z.boolean()).default(true),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
  process.stderr.write(`[config] Fatal: invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  discord: {
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    allowedChannelIds: env.ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean),
  },
  upscale: {
    enabled: env.UPSCALE_ENABLED,
    model: env.UPSCALE_MODEL,
    workflow: env.UPSCALE_WORKFLOW,
  },
  comfy: {
    baseUrl: env.COMFY_BASE_URL.replace(/\/$/, ""),
    timeoutMs: env.COMFY_TIMEOUT_MS,
  },
  queue: {
    concurrency: env.QUEUE_CONCURRENCY,
  },
  db: {
    path: env.DB_PATH,
  },
  logLevel: env.LOG_LEVEL,
  defaultNegativePrompt: env.DEFAULT_NEGATIVE_PROMPT,
} as const;

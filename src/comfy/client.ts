import { request, FormData } from "undici";
import { Blob } from "node:buffer";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface ComfyHistoryEntry {
  status: { completed: boolean; status_str: string };
  outputs: Record<
    string,
    { images?: Array<{ filename: string; subfolder: string; type: string }> }
  >;
}

export interface ComfyClient {
  ping(): Promise<boolean>;
  getObjectInfo(): Promise<Record<string, unknown>>;
  submitPrompt(workflow: Record<string, unknown>): Promise<{ promptId: string }>;
  getHistory(promptId: string): Promise<ComfyHistoryEntry | null>;
  getImage(filename: string, subfolder: string, type: string): Promise<Buffer>;
  uploadImage(buffer: Buffer, filename: string): Promise<{ name: string; subfolder: string; type: string }>;
  /**
   * Read the safetensors metadata header for a LoRA file and return the embedded
   * SHA-256 hash (if present). Returns null if the file has no hash metadata or
   * if the /view_metadata endpoint is unavailable.
   */
  getLoraFileHash(filename: string): Promise<string | null>;
  /**
   * Query the LoRA Manager plugin for trigger words associated with a LoRA file.
   * Returns the trigger words array (may be empty) if the plugin is installed and
   * knows the file, or null on any failure (plugin absent, timeout, etc.) so the
   * caller can fall through to an alternative source.
   */
  getLoraManagerTriggerWords(filename: string): Promise<string[] | null>;
}

function base(): string {
  return config.comfy.baseUrl;
}

async function jsonGet<T>(path: string): Promise<T> {
  const { statusCode, body } = await request(`${base()}${path}`, { method: "GET" });
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`ComfyUI GET ${path} returned HTTP ${statusCode}`);
  }
  return body.json() as Promise<T>;
}

export const comfyClient: ComfyClient = {
  async ping(): Promise<boolean> {
    try {
      const { statusCode } = await request(`${base()}/system_stats`, {
        method: "GET",
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      return statusCode === 200;
    } catch {
      return false;
    }
  },

  async getObjectInfo(): Promise<Record<string, unknown>> {
    return jsonGet<Record<string, unknown>>("/object_info");
  },

  async submitPrompt(workflow: Record<string, unknown>): Promise<{ promptId: string }> {
    const body = JSON.stringify({ prompt: workflow });
    const { statusCode, body: resBody } = await request(`${base()}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (statusCode < 200 || statusCode >= 300) {
      const text = await resBody.text();
      throw new Error(`ComfyUI POST /prompt returned HTTP ${statusCode}: ${text}`);
    }
    const json = (await resBody.json()) as { prompt_id: string };
    logger.debug({ promptId: json.prompt_id }, "ComfyUI prompt submitted");
    return { promptId: json.prompt_id };
  },

  async getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
    try {
      const data = await jsonGet<Record<string, unknown>>(`/history/${promptId}`);
      const entry = data[promptId] as ComfyHistoryEntry | undefined;
      return entry ?? null;
    } catch {
      return null;
    }
  },

  async getImage(filename: string, subfolder: string, type: string): Promise<Buffer> {
    const url = `${base()}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    const { statusCode, body } = await request(url);
    if (statusCode !== 200) {
      throw new Error(`ComfyUI image fetch returned HTTP ${statusCode} for ${filename}`);
    }
    const bytes = await body.arrayBuffer();
    return Buffer.from(bytes);
  },

  async uploadImage(buffer: Buffer, filename: string): Promise<{ name: string; subfolder: string; type: string }> {
    const formData = new FormData();
    formData.append("image", new Blob([new Uint8Array(buffer)], { type: "image/png" }), filename);
    formData.append("overwrite", "true");

    const { statusCode, body: resBody } = await request(`${base()}/upload/image`, {
      method: "POST",
      body: formData,
    });
    if (statusCode < 200 || statusCode >= 300) {
      const text = await resBody.text();
      throw new Error(`ComfyUI POST /upload/image returned HTTP ${statusCode}: ${text}`);
    }
    const json = (await resBody.json()) as { name: string; subfolder: string; type: string };
    logger.debug({ name: json.name }, "Image uploaded to ComfyUI input folder");
    return { name: json.name, subfolder: json.subfolder, type: json.type };
  },

  async getLoraFileHash(filename: string): Promise<string | null> {
    const url = `${base()}/view_metadata/loras?filename=${encodeURIComponent(filename)}`;
    try {
      const { statusCode, body } = await request(url,
        { method: "GET", headersTimeout: 5_000, bodyTimeout: 10_000 },
      );
      if (statusCode !== 200) {
        logger.debug({ filename, statusCode }, "[lora-hash] /view_metadata/loras returned non-200");
        return null;
      }
      const meta = await body.json() as Record<string, unknown>;
      const keys = Object.keys(meta);
      logger.debug({ filename, keys }, "[lora-hash] safetensors metadata keys");
      // CivitAI's downloader embeds the SHA-256 in safetensors metadata under keys
      // such as "modelspec.hash.sha256", "sshs_model_hash", or "sha256".
      const sha256Key = keys.find((k) => k.toLowerCase().includes("sha256"));
      if (sha256Key && typeof meta[sha256Key] === "string" && (meta[sha256Key] as string).length >= 8) {
        logger.debug({ filename, sha256Key, hash: meta[sha256Key] }, "[lora-hash] found sha256 hash");
        return meta[sha256Key] as string;
      }
      const hashKey = keys.find((k) => k.toLowerCase() === "sshs_model_hash");
      if (hashKey && typeof meta[hashKey] === "string") {
        logger.debug({ filename, hashKey, hash: meta[hashKey] }, "[lora-hash] found sshs_model_hash");
        return meta[hashKey] as string;
      }
      logger.debug({ filename }, "[lora-hash] no usable hash key found in metadata");
      return null;
    } catch (err) {
      logger.debug({ filename, err }, "[lora-hash] exception fetching metadata");
      return null;
    }
  },

  async getLoraManagerTriggerWords(filename: string): Promise<string[] | null> {
    // LoRA Manager stores file_name without extension — strip it before querying.
    const stem = filename.replace(/\.[^.]+$/, "");
    const url = `${base()}/api/lm/loras/get-trigger-words?name=${encodeURIComponent(stem)}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) {
        logger.debug({ filename, status: resp.status }, "[lora-manager] get-trigger-words non-200");
        return null;
      }
      const data = await resp.json() as { success?: boolean; trigger_words?: unknown[] };
      if (data.success !== true) {
        logger.debug({ filename }, "[lora-manager] get-trigger-words success=false");
        return null;
      }
      // LoRA Manager may return comma-separated words as a single string element
      // e.g. ["dynamic pose, foreshortening, extreme perspective"] → split and trim each.
      const words = (data.trigger_words ?? [])
        .filter((w): w is string => typeof w === "string")
        .flatMap((w) => w.split(",").map((t) => t.trim()).filter(Boolean));
      logger.debug({ filename, words }, "[lora-manager] trigger words returned");
      return words;
    } catch (err) {
      logger.debug({ filename, err }, "[lora-manager] get-trigger-words failed (plugin absent?)");
      return null;
    }
  },
};

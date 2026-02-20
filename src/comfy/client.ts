import { request } from "undici";
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
};

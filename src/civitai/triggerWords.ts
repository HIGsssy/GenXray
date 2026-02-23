import { fetchLoraMetadata } from "./client.js";
import { comfyClient } from "../comfy/client.js";

interface CacheEntry {
  triggerWords: string[];
  cachedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const _cache = new Map<string, CacheEntry>();

/**
 * Returns trigger words for a LoRA filename.
 * Successful results (including definitive empty arrays) are cached for 24 hours.
 * Transient failures (null from fetchLoraMetadata) are NOT cached so the next
 * interaction retries the lookup.
 */
export async function getTriggerWords(
  filename: string,
  apiKey?: string,
  hash?: string,
): Promise<string[]> {
  const entry = _cache.get(filename);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) {
    return entry.triggerWords;
  }

  // --- 1. LoRA Manager plugin (local, fast, zero extra config) ---
  const lmResult = await comfyClient.getLoraManagerTriggerWords(filename);
  if (lmResult !== null && lmResult.length > 0) {
    // Plugin returned actual trigger words — definitive, cache and skip CivitAI.
    _cache.set(filename, { triggerWords: lmResult, cachedAt: Date.now() });
    return lmResult;
  }
  // lmResult === null  → plugin absent or failed, fall through
  // lmResult === []    → plugin didn't recognise the filename OR genuinely no trigger
  //                      words; the API can't distinguish these, so fall through to
  //                      CivitAI rather than caching a potentially wrong empty result.

  // --- 2. CivitAI fallback (hash lookup → text search) ---
  const result = await fetchLoraMetadata(filename, apiKey, hash);

  if (result === null) {
    // Transient failure — return empty for now but do not poison the cache
    return [];
  }

  _cache.set(filename, { triggerWords: result, cachedAt: Date.now() });
  return result;
}

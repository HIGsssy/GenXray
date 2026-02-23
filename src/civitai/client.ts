import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Hash-based lookup — most reliable, directly identifies the exact file version
// ---------------------------------------------------------------------------

/**
 * Look up a model version by its SHA-256 (or AutoV2) hash embedded in the
 * safetensors metadata. Returns the trigger words on success (may be an empty
 * array if the model has none), or null on a transient failure (rate-limit,
 * network error). A 404 is treated as a definitive "not on CivitAI" and
 * returns [].
 */
async function fetchTriggerWordsByHash(
  hash: string,
  apiKey?: string,
): Promise<string[] | null> {
  const url = `https://civitai.com/api/v1/model-versions/by-hash/${encodeURIComponent(hash)}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  logger.debug({ hash, url }, "[civitai] hash lookup starting");
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    logger.debug({ hash, status: resp.status }, "[civitai] hash lookup response");
    if (resp.status === 404) {
      logger.debug({ hash }, "[civitai] LoRA not found by hash (custom/private model)");
      return []; // definitive — not on CivitAI
    }
    if (resp.status === 429) {
      logger.warn({ hash }, "CivitAI rate-limited (429) on hash lookup");
      return null; // transient
    }
    if (!resp.ok) {
      logger.warn({ hash, status: resp.status }, "CivitAI hash lookup returned non-OK status");
      return null;
    }
    const data = await resp.json() as { trainedWords?: unknown[] };
    const words = (data.trainedWords ?? []).filter((w): w is string => typeof w === "string");
    logger.debug({ hash, words }, "[civitai] trigger words via hash lookup");
    return words;
  } catch (err) {
    logger.warn({ hash, err }, "CivitAI hash lookup failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Text-search fallback
// ---------------------------------------------------------------------------

type SearchItem = {
  name?: string;
  modelVersions?: {
    trainedWords?: unknown[];
    files?: { name?: string }[];
  }[];
};

/**
 * Score how well a search result item matches the local filename.
 * Checks whether any version's file list contains a file whose stem matches.
 */
function fileMatchScore(item: SearchItem, filenameStem: string): number {
  const target = filenameStem.toLowerCase();
  for (const ver of item.modelVersions ?? []) {
    for (const file of ver.files ?? []) {
      const stem = (file.name ?? "").replace(/\.[^.]+$/, "").toLowerCase();
      if (stem === target) return 3;
      if (stem.startsWith(target) || target.startsWith(stem)) return 2;
    }
  }
  return 0;
}

/** Collect and deduplicate trainedWords from ALL versions of a single item. */
function collectWords(item: SearchItem): string[] {
  return [
    ...new Set(
      (item.modelVersions ?? []).flatMap((v) =>
        (v.trainedWords ?? []).filter((w): w is string => typeof w === "string"),
      ),
    ),
  ];
}

/** Run one text-search query and return trigger words for the best-matching result. */
async function searchByQuery(
  query: string,
  filenameStem: string,
  headers: Record<string, string>,
): Promise<string[] | null> {
  const url = `https://civitai.com/api/v1/models?query=${encodeURIComponent(query)}&types=LORA&limit=5`;
  logger.debug({ query, url }, "[civitai] text search starting");
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    logger.debug({ query, status: resp.status }, "[civitai] text search response");
    if (resp.status === 429) return null;
    if (!resp.ok) return null;
    const data = await resp.json() as { items?: SearchItem[] };
    const resultNames = (data.items ?? []).map((i) => i.name ?? "(unnamed)");
    logger.debug({ query, resultNames }, "[civitai] text search result names");
    if (!data.items?.length) return [];

    // Pick the item whose version files best match the local filename
    let best: SearchItem = data.items[0]!;
    let bestScore = -1;
    for (const item of data.items) {
      const score = fileMatchScore(item, filenameStem);
      if (score > bestScore) { bestScore = score; best = item; }
    }
    logger.debug({ query, chosen: best.name, bestScore }, "[civitai] text search best match");

    const words = collectWords(best);
    logger.debug({ query, words }, "[civitai] text search trigger words");
    return words;
  } catch (err) {
    logger.warn({ query, err }, "[civitai] text search failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch trigger words for a LoRA file.
 *
 * Strategy (in order):
 *  1. Hash-based lookup via /model-versions/by-hash/:hash  (exact, always correct)
 *  2. Text search with raw filename stem
 *  3. Text search with normalised filename (separators stripped, version suffix removed)
 *
 * Returns string[] on success (may be empty), null on transient failure.
 */
export async function fetchLoraMetadata(
  filename: string,
  apiKey?: string,
  hash?: string,
): Promise<string[] | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  logger.debug({ filename, hash: hash ?? null }, "[civitai] fetchLoraMetadata called");

  // --- 1. Hash lookup ---
  if (hash) {
    const result = await fetchTriggerWordsByHash(hash, apiKey);
    if (result !== null && result.length > 0) {
      // Hash found and has trigger words — definitive, no need to text-search
      return result;
    }
    // result === null  → transient error; fall through
    // result === []    → 404 (not indexed by this hash) or model has no trigger words;
    //                    still try text search in case the model is findable by name
    logger.debug({ filename, hashResult: result }, "[civitai] hash lookup inconclusive, trying text search");
  }

  // --- 2 & 3. Text search fallback ---
  const rawStem = filename.replace(/\.[^.]+$/, "");
  const normStem = rawStem.replace(/[-_]v\d+(\.\d+)?$/i, "").replace(/[-_]/g, " ").trim();

  const words1 = await searchByQuery(rawStem, rawStem, headers);
  if (words1 !== null && words1.length > 0) return words1;

  if (normStem !== rawStem) {
    const words2 = await searchByQuery(normStem, rawStem, headers);
    if (words2 !== null) return words2;
  }

  return words1; // [] or null
}

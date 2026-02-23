import { comfyClient } from "./client.js";
import { logger } from "../logger.js";

export interface ComfyOptions {
  models: string[];
  samplers: string[];
  schedulers: string[];
  loras: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pickStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).filter((v): v is string => typeof v === "string");
  }
  return [];
}

function getNodeInputList(
  objectInfo: Record<string, unknown>,
  classType: string,
  field: string,
): string[] | null {
  const node = objectInfo[classType] as Record<string, unknown> | undefined;
  if (!node) return null;
  const input = (node.input ?? node.inputs) as Record<string, unknown> | undefined;
  if (!input) return null;
  const required = input.required as Record<string, unknown> | undefined;
  const optional = input.optional as Record<string, unknown> | undefined;
  const fieldDef = (required?.[field] ?? optional?.[field]) as unknown[] | undefined;
  if (!Array.isArray(fieldDef)) return null;
  // ComfyUI field defs: [listOrType, config?]
  const listOrType = fieldDef[0];
  return pickStrings(listOrType);
}

// ---------------------------------------------------------------------------
// LoRA detection
// ---------------------------------------------------------------------------

export function getLoras(objectInfo: Record<string, unknown>): string[] {
  return getNodeInputList(objectInfo, "LoraLoader", "lora_name") ?? [];
}

// ---------------------------------------------------------------------------
// Checkpoint loader detection (Section 6.1)
// ---------------------------------------------------------------------------

const CHECKPOINT_CLASSES = [
  "CheckpointLoaderSimpleMikey",
  "CheckpointLoaderSimple",
];

function findCheckpointClass(objectInfo: Record<string, unknown>): string | null {
  for (const cls of CHECKPOINT_CLASSES) {
    if (cls in objectInfo) return cls;
  }
  // Fuzzy fallback
  const fuzzy = Object.keys(objectInfo).find((k) => k.toLowerCase().includes("checkpointloader"));
  if (fuzzy) {
    logger.warn({ class: fuzzy }, "Using fuzzy-matched checkpoint loader class");
    return fuzzy;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sampler / scheduler detection (Section 6.2)
// ---------------------------------------------------------------------------

const SAMPLER_CLASSES = [
  "KSamplerAdvancedEfficient",
  "KSamplerEfficient",
  "KSampler",
];

function findSamplerClass(objectInfo: Record<string, unknown>): string | null {
  for (const cls of SAMPLER_CLASSES) {
    if (cls in objectInfo) {
      if (cls === "KSampler") {
        logger.warn(
          "Efficient KSampler class not found; falling back to KSampler. " +
          "The workflow uses KSampler (Efficient) nodes — results may differ.",
        );
      }
      return cls;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _cached: ComfyOptions | null = null;

/**
 * Fetch and return the cached option lists.
 * Call once at startup; results are held for the process lifetime.
 * Throws (fatal) if required classes cannot be found.
 */
export async function fetchOptions(): Promise<ComfyOptions> {
  if (_cached) return _cached;

  const objectInfo = await comfyClient.getObjectInfo();

  // --- Models ---
  const ckptClass = findCheckpointClass(objectInfo);
  if (!ckptClass) {
    throw new Error(
      "Fatal: no checkpoint loader node class found in ComfyUI object_info. " +
      `Searched: ${CHECKPOINT_CLASSES.join(", ")} and fuzzy match on 'CheckpointLoader'. ` +
      "Ensure CheckpointLoaderSimpleMikey (or a standard checkpoint loader) is installed.",
    );
  }
  logger.info({ class: ckptClass }, "Using checkpoint loader class");

  const models = getNodeInputList(objectInfo, ckptClass, "ckpt_name") ?? [];
  if (models.length === 0) {
    throw new Error(
      `Fatal: checkpoint loader class '${ckptClass}' has no 'ckpt_name' options. ` +
      "No models appear to be installed in ComfyUI.",
    );
  }

  // --- Samplers / Schedulers ---
  const samplerClass = findSamplerClass(objectInfo);
  if (!samplerClass) {
    throw new Error(
      "Fatal: no KSampler class found in ComfyUI object_info. " +
      `Searched: ${SAMPLER_CLASSES.join(", ")}.`,
    );
  }
  logger.info({ class: samplerClass }, "Using sampler class");

  const samplers = getNodeInputList(objectInfo, samplerClass, "sampler_name") ?? [];
  const schedulers = getNodeInputList(objectInfo, samplerClass, "scheduler") ?? [];

  if (samplers.length === 0) {
    throw new Error(`Fatal: sampler class '${samplerClass}' has no 'sampler_name' options.`);
  }
  if (schedulers.length === 0) {
    throw new Error(`Fatal: sampler class '${samplerClass}' has no 'scheduler' options.`);
  }

  // Discord select menus cap at 25 options
  const cap = (arr: string[], label: string): string[] => {
    if (arr.length > 25) {
      logger.warn({ count: arr.length, label }, "Option list exceeds 25; truncating to 25 for Discord select menu");
      return arr.slice(0, 25);
    }
    return arr;
  };

  // LoRAs — optional, no fatal error if none found; cap at 100 for the select menus
  const allLoras = getLoras(objectInfo);
  const loras = allLoras.length > 100 ? allLoras.slice(0, 100) : allLoras;

  _cached = {
    models: cap(models, "models"),
    samplers: cap(samplers, "samplers"),
    schedulers: cap(schedulers, "schedulers"),
    loras,
  };

  logger.info(
    { models: _cached.models.length, samplers: _cached.samplers.length, schedulers: _cached.schedulers.length, loras: _cached.loras.length },
    "ComfyUI options loaded",
  );
  return _cached;
}

/** Clear the cache (e.g. for a future !refresh command). */
export function clearOptionsCache(): void {
  _cached = null;
}

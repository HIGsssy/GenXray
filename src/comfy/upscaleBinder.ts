import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { UpscaleJobRow } from "../queue/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Result types (reuse same shape as workflowBinder)
// ---------------------------------------------------------------------------

export interface UpscaleBindOk {
  ok: true;
  workflow: Record<string, unknown>;
}

export interface UpscaleBindError {
  ok: false;
  reason: string;
}

export type UpscaleBindResult = UpscaleBindOk | UpscaleBindError;

// ---------------------------------------------------------------------------
// Workflow caches
// ---------------------------------------------------------------------------

let _ultimateCache: string | null = null;
let _simpleCache: string | null = null;

export function loadUltimateWorkflow(): Record<string, unknown> {
  if (!_ultimateCache) {
    const wfPath = resolve(__dirname, "../../workflows/upscaler/ultimate.json");
    _ultimateCache = readFileSync(wfPath, "utf-8");
    logger.debug({ wfPath }, "Upscale workflow ultimate.json loaded from disk");
  }
  return JSON.parse(_ultimateCache) as Record<string, unknown>;
}

export function loadSimpleWorkflow(): Record<string, unknown> {
  if (!_simpleCache) {
    const wfPath = resolve(__dirname, "../../workflows/upscaler/simple.json");
    _simpleCache = readFileSync(wfPath, "utf-8");
    logger.debug({ wfPath }, "Upscale workflow simple.json loaded from disk");
  }
  return JSON.parse(_simpleCache) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Required nodes per workflow variant
// ---------------------------------------------------------------------------

/** Nodes that must be present and have the listed fields. */
const REQUIRED_ULTIMATE: Record<string, string[]> = {
  "125": ["ckpt_name"],   // CheckpointLoaderSimple
  "126": ["model_name"],  // UpscaleModelLoader
  "134": ["image"],       // UltimateSDUpscaleCustomSample
  "146": ["image"],       // Image Load with Metadata (WLSH)
  "123": ["text"],        // CLIPTextEncode positive
  "124": ["text"],        // CLIPTextEncode negative
};

const REQUIRED_SIMPLE: Record<string, string[]> = {
  "1": ["image"],         // LoadImage
  "2": ["model_name"],   // UpscaleModelLoader
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInputs(workflow: Record<string, unknown>, nodeId: string): Record<string, unknown> | null {
  const n = workflow[nodeId];
  if (typeof n !== "object" || n === null) return null;
  const inp = (n as Record<string, unknown>)["inputs"];
  if (typeof inp !== "object" || inp === null) return null;
  return inp as Record<string, unknown>;
}

function setField(workflow: Record<string, unknown>, nodeId: string, field: string, value: unknown): void {
  const inp = getInputs(workflow, nodeId);
  if (inp) inp[field] = value;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateUpscaleWorkflows(): UpscaleBindResult {
  try {
    const ultimate = loadUltimateWorkflow();
    for (const [nodeId, fields] of Object.entries(REQUIRED_ULTIMATE)) {
      const inp = getInputs(ultimate, nodeId);
      if (!inp) return { ok: false, reason: `ultimate.json missing node "${nodeId}"` };
      for (const f of fields) {
        if (inp[f] === undefined || inp[f] === null) {
          return { ok: false, reason: `ultimate.json node "${nodeId}" missing field "${f}"` };
        }
      }
    }
  } catch (err) {
    return { ok: false, reason: `Could not load ultimate.json: ${String(err)}` };
  }

  try {
    const simple = loadSimpleWorkflow();
    for (const [nodeId, fields] of Object.entries(REQUIRED_SIMPLE)) {
      const inp = getInputs(simple, nodeId);
      if (!inp) return { ok: false, reason: `simple.json missing node "${nodeId}"` };
      for (const f of fields) {
        if (inp[f] === undefined || inp[f] === null) {
          return { ok: false, reason: `simple.json node "${nodeId}" missing field "${f}"` };
        }
      }
    }
  } catch (err) {
    return { ok: false, reason: `Could not load simple.json: ${String(err)}` };
  }

  return { ok: true, workflow: {} };
}

// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------

/**
 * Deep-clone the selected upscale workflow, inject runtime values, and
 * return the ready-to-submit workflow.
 *
 * @param job        The upscale job row (provides model, prompts, upscale model).
 * @param uploadedFilename  The filename returned by ComfyUI's /upload/image endpoint.
 */
export function bindUpscale(job: UpscaleJobRow, uploadedFilename: string): UpscaleBindResult {
  const variant = config.upscale.workflow;

  if (variant === "ultimate") {
    let base: Record<string, unknown>;
    try {
      base = loadUltimateWorkflow();
    } catch (err) {
      return { ok: false, reason: `Failed to load ultimate.json: ${String(err)}` };
    }

    const wf: Record<string, unknown> = JSON.parse(JSON.stringify(base));

    // Node "146" — WLSH image loader: inject the uploaded filename
    setField(wf, "146", "image", uploadedFilename);

    // Node "125" — checkpoint model (reuse the original generation model)
    setField(wf, "125", "ckpt_name", job.model);

    // Node "126" — ESRGAN upscale model
    setField(wf, "126", "model_name", job.upscaleModel);

    // Nodes "123" / "124" — override wired metadata outputs with real strings
    // (base workflow SaveImage does not embed PNG metadata, so WLSH outputs
    // empty strings; injecting here ensures the 0.25 denoise pass is guided)
    setField(wf, "123", "text", job.positivePrompt);
    setField(wf, "124", "text", job.negativePrompt);

    logger.debug({ jobId: job.id, variant }, "Upscale workflow bound (ultimate)");
    return { ok: true, workflow: wf };
  }

  // variant === "simple"
  let base: Record<string, unknown>;
  try {
    base = loadSimpleWorkflow();
  } catch (err) {
    return { ok: false, reason: `Failed to load simple.json: ${String(err)}` };
  }

  const wf: Record<string, unknown> = JSON.parse(JSON.stringify(base));

  // Node "1" — LoadImage: inject the uploaded filename
  setField(wf, "1", "image", uploadedFilename);

  // Node "2" — UpscaleModelLoader
  setField(wf, "2", "model_name", job.upscaleModel);

  logger.debug({ jobId: job.id, variant }, "Upscale workflow bound (simple)");
  return { ok: true, workflow: wf };
}

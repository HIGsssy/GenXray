import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobRow, LoraParam } from "../queue/types.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface BindOk {
  ok: true;
  workflow: Record<string, unknown>;
}

export interface BindError {
  ok: false;
  reason: string; // safe to surface to Discord user
}

export type BindResult = BindOk | BindError;

// ---------------------------------------------------------------------------
// Workflow binding rules (LOCKED — do not modify without architecture review)
//
//  Node  | Field(s) written
//  ------|---------------------------------------------------------
//  "6"   | inputs.width, inputs.height               (latent size)
//  "152" | inputs.ckpt_name                  (checkpoint model)
//  "268" | inputs.text                       (positive prompt)
//  "4"   | inputs.text                       (negative prompt)
//  "239" | inputs.sampler_name, scheduler,   (BASE sampler — all fields)
//         | inputs.steps, inputs.cfg
//  "249" | inputs.sampler_name, scheduler    (sampler/scheduler ONLY)
//  "52"  | inputs.sampler_name, scheduler    (sampler/scheduler ONLY)
//  "118" | inputs.sampler_name, scheduler    (sampler/scheduler ONLY)
//
//  steps / cfg are written ONLY to node "239".
// ---------------------------------------------------------------------------

const REQUIRED_NODES = ["6", "152", "256", "268", "4", "239", "249", "52", "118"] as const;

/** Fields each node must have. Used by validate(). */
const REQUIRED_FIELDS: Record<string, string[]> = {
  "6": ["width", "height"],
  "152": ["ckpt_name"],
  "256": ["seed"],
  "268": ["text"],
  "4": ["text"],
  "239": ["sampler_name", "scheduler", "steps", "cfg"],
  "249": ["sampler_name", "scheduler"],
  "52": ["sampler_name", "scheduler"],
  "118": ["sampler_name", "scheduler"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(workflow: Record<string, unknown>, id: string): Record<string, unknown> | null {
  const n = workflow[id];
  if (typeof n !== "object" || n === null) return null;
  return n as Record<string, unknown>;
}

function inputs(n: Record<string, unknown>): Record<string, unknown> | null {
  const inp = n["inputs"];
  if (typeof inp !== "object" || inp === null) return null;
  return inp as Record<string, unknown>;
}

function setField(workflow: Record<string, unknown>, nodeId: string, field: string, value: unknown): void {
  const n = node(workflow, nodeId);
  if (!n) return;
  const inp = inputs(n);
  if (!inp) return;
  inp[field] = value;
}

// ---------------------------------------------------------------------------
// Size map
// ---------------------------------------------------------------------------

const SIZE_MAP: Record<string, [number, number]> = {
  portrait:  [832, 1216],
  square:    [1024, 1024],
  landscape: [1216, 832],
};

// ---------------------------------------------------------------------------
// Load base workflow from disk
// ---------------------------------------------------------------------------

let _workflowCache: string | null = null;

function loadBase(): Record<string, unknown> {
  if (!_workflowCache) {
    const wfPath = resolve(__dirname, "../../workflows/multisampler/base.json");
    _workflowCache = readFileSync(wfPath, "utf-8");
    logger.debug({ wfPath }, "Workflow base.json loaded from disk");
  }
  return JSON.parse(_workflowCache) as Record<string, unknown>;
}

/** Exposed so startup can pre-load and validate the file early. */
export function loadBaseWorkflow(): Record<string, unknown> {
  return loadBase();
}

// ---------------------------------------------------------------------------
// LoRA injection
// ---------------------------------------------------------------------------

/**
 * Injects LoraLoader nodes into the workflow for each active LoRA.
 * The first node chains from checkpoint node "152"; each subsequent node
 * chains from the previous. After injection, all other nodes that referenced
 * "152" for MODEL (output 0) or CLIP (output 1) are re-pointed to the last
 * LoRA node so the chain is complete.
 */
function injectLoras(wf: Record<string, unknown>, loras: (LoraParam | null)[]): void {
  const active = loras.filter((l): l is LoraParam => l !== null).slice(0, 4);
  if (active.length === 0) return;

  const loraNodeIds = active.map((_, i) => String(2001 + i));

  // Build LoraLoader nodes
  for (let i = 0; i < active.length; i++) {
    const id = loraNodeIds[i];
    const prevId = i === 0 ? "152" : loraNodeIds[i - 1];
    wf[id] = {
      class_type: "LoraLoader",
      inputs: {
        model: [prevId, 0],
        clip: [prevId, 1],
        lora_name: active[i].name,
        strength_model: active[i].strength,
        strength_clip: active[i].strength,
      },
    };
  }

  const lastLoraId = loraNodeIds[loraNodeIds.length - 1];

  // Re-point all existing nodes (not the new LoRA nodes) that reference node "152"
  // for MODEL (output 0) or CLIP (output 1)
  for (const [nodeId, nodeData] of Object.entries(wf)) {
    if (loraNodeIds.includes(nodeId)) continue;
    if (typeof nodeData !== "object" || nodeData === null) continue;
    const inp = (nodeData as Record<string, unknown>)["inputs"];
    if (typeof inp !== "object" || inp === null) continue;
    for (const [field, val] of Object.entries(inp as Record<string, unknown>)) {
      if (!Array.isArray(val) || val.length < 2) continue;
      if (val[0] === "152" && val[1] === 0) {
        (inp as Record<string, unknown>)[field] = [lastLoraId, 0];
      } else if (val[0] === "152" && val[1] === 1) {
        (inp as Record<string, unknown>)[field] = [lastLoraId, 1];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

/**
 * Validate that the given workflow object contains all required nodes and fields.
 * Returns BindError on first failure so the caller has a specific message.
 */
export function validate(workflow: unknown): BindResult {
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
    return { ok: false, reason: "Workflow is not a plain object." };
  }
  const wf = workflow as Record<string, unknown>;

  for (const nodeId of REQUIRED_NODES) {
    const n = node(wf, nodeId);
    if (!n) {
      return { ok: false, reason: `Workflow is missing required node "${nodeId}".` };
    }
    const inp = inputs(n);
    if (!inp) {
      return { ok: false, reason: `Node "${nodeId}" is missing an "inputs" object.` };
    }
    for (const field of REQUIRED_FIELDS[nodeId] ?? []) {
      if (inp[field] === undefined || inp[field] === null) {
        return { ok: false, reason: `Node "${nodeId}" inputs.${field} is missing or null.` };
      }
    }
  }

  return { ok: true, workflow: wf };
}

// ---------------------------------------------------------------------------
// bind()
// ---------------------------------------------------------------------------

/**
 * Deep-clone base.json, inject all job parameters per the binding rules,
 * and return the ready-to-submit workflow.
 */
export function bind(job: JobRow): BindResult {
  const base = loadBase();
  const result = validate(base);
  if (!result.ok) return result;

  // Deep clone so each job gets its own copy
  const wf: Record<string, unknown> = JSON.parse(JSON.stringify(base));

  // Inject LoRA nodes if any are active (must happen before re-pointing refs)
  if (job.loras && job.loras.some(Boolean)) {
    injectLoras(wf, job.loras);
  }

  // Node "6" — latent image size
  const [w, h] = SIZE_MAP[job.size] ?? SIZE_MAP["portrait"];
  setField(wf, "6", "width", w);
  setField(wf, "6", "height", h);

  // Node "152" — checkpoint model
  setField(wf, "152", "ckpt_name", job.model);

  // Node "256" — Seed Generator: inject resolved seed
  setField(wf, "256", "seed", job.seed);

  // Node "268" — positive prompt (combined with LoRA trigger words)
  const triggerWords = (job.loras ?? [])
    .filter((l): l is LoraParam => l !== null)
    .flatMap((l) => l.triggerWords);
  const combinedPrompt = [job.positivePrompt, ...triggerWords].filter(Boolean).join(" ").trim();
  setField(wf, "268", "text", combinedPrompt || job.positivePrompt);

  // Node "4" — negative prompt
  setField(wf, "4", "text", job.negativePrompt);

  // Node "239" — base sampler: all four fields
  setField(wf, "239", "sampler_name", job.sampler);
  setField(wf, "239", "scheduler", job.scheduler);
  setField(wf, "239", "steps", job.steps);
  setField(wf, "239", "cfg", job.cfg);

  // Nodes "249", "52", "118" — sampler/scheduler ONLY (no steps, no cfg)
  for (const nodeId of ["249", "52", "118"] as const) {
    setField(wf, nodeId, "sampler_name", job.sampler);
    setField(wf, nodeId, "scheduler", job.scheduler);
  }

  logger.debug({ jobId: job.id }, "Workflow bound for job");
  return { ok: true, workflow: wf };
}

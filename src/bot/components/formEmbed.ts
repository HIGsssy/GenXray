import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { ComfyOptions } from "../../comfy/objectInfo.js";
import type { JobRow } from "../../queue/types.js";

// ---------------------------------------------------------------------------
// Custom ID constants
// ---------------------------------------------------------------------------

export const CUSTOM_ID = {
  SELECT_MODEL: "gen_select_model",
  SELECT_SAMPLER: "gen_select_sampler",
  SELECT_SCHEDULER: "gen_select_scheduler",
  BTN_EDIT_PROMPTS: "gen_btn_edit_prompts",
  BTN_GENERATE: "gen_btn_generate",
  MODAL_PROMPTS: "gen_modal_prompts",
  MODAL_FIELD_POS: "gen_field_positive",
  MODAL_FIELD_NEG: "gen_field_negative",
  MODAL_FIELD_STEPS: "gen_field_steps",
  MODAL_FIELD_CFG: "gen_field_cfg",
  MODAL_FIELD_SEED: "gen_field_seed",
  // Prefix for share-prompt buttons on output posts — full customId: `${prefix}:${jobId}`
  SHARE_PROMPT_PREFIX: "gen_share_prompt",
  // Prefix for re-roll buttons on output posts — full customId: `${prefix}:${jobId}`
  REROLL_PREFIX: "gen_reroll",
  // Prefix for delete buttons on output posts — full customId: `${prefix}:${jobId}`
  DELETE_PREFIX: "gen_delete",
  // Prefix for edit buttons on output posts — full customId: `${prefix}:${jobId}`
  EDIT_PREFIX: "gen_edit",
} as const;

// ---------------------------------------------------------------------------
// Draft state (per-user in-process map)
// ---------------------------------------------------------------------------

export interface DraftParams {
  model: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  seed: number;
  positivePrompt: string;
  negativePrompt: string;
}

const _drafts = new Map<string, DraftParams>();

/** Generate a random seed in the ComfyUI valid range (0–4 294 967 295). */
function randomSeed(): number {
  return Math.floor(Math.random() * 4_294_967_296);
}

export function initDraft(userId: string, options: ComfyOptions): DraftParams {
  const draft: DraftParams = {
    model: options.models[0] ?? "",
    sampler: options.samplers.includes("dpmpp_2m_sde") ? "dpmpp_2m_sde" : (options.samplers[0] ?? ""),
    scheduler: options.schedulers.includes("karras") ? "karras" : (options.schedulers[0] ?? ""),
    steps: 28,
    cfg: 5,
    seed: randomSeed(),
    positivePrompt: "",
    negativePrompt: "",
  };
  _drafts.set(userId, draft);
  return draft;
}

/** Seed a draft from an existing completed job (used by the Edit button on output posts). */
export function initDraftFromJob(userId: string, job: JobRow): DraftParams {
  const draft: DraftParams = {
    model: job.model,
    sampler: job.sampler,
    scheduler: job.scheduler,
    steps: job.steps,
    cfg: job.cfg,
    seed: job.seed,
    positivePrompt: job.positivePrompt,
    negativePrompt: job.negativePrompt,
  };
  _drafts.set(userId, draft);
  return draft;
}

export function getDraft(userId: string): DraftParams | undefined {
  return _drafts.get(userId);
}

export function mergeDraft(userId: string, partial: Partial<DraftParams>): DraftParams {
  const existing = _drafts.get(userId);
  if (!existing) throw new Error(`No draft found for user ${userId}`);
  const updated = { ...existing, ...partial };
  _drafts.set(userId, updated);
  return updated;
}

export function deleteDraft(userId: string): void {
  _drafts.delete(userId);
}

// ---------------------------------------------------------------------------
// Embed builder
// ---------------------------------------------------------------------------

export function buildFormEmbed(draft: DraftParams): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Image Generation")
    .setColor(0x5865f2)
    .setDescription("Configure your generation settings, then click **Generate**.")
    .addFields(
      { name: "Model", value: draft.model || "_not selected_", inline: true },
      { name: "Sampler", value: draft.sampler || "_not selected_", inline: true },
      { name: "Scheduler", value: draft.scheduler || "_not selected_", inline: true },
      { name: "Steps", value: String(draft.steps), inline: true },
      { name: "CFG", value: String(draft.cfg), inline: true },
      { name: "Seed", value: String(draft.seed), inline: true },
      {
        name: "Positive Prompt",
        value: draft.positivePrompt.length > 0 ? `\`\`\`${draft.positivePrompt.slice(0, 500)}\`\`\`` : "_not set_",
      },
      {
        name: "Negative Prompt",
        value: draft.negativePrompt.length > 0 ? `\`\`\`${draft.negativePrompt.slice(0, 300)}\`\`\`` : "_none_",
      },
    );
}

// ---------------------------------------------------------------------------
// Component row builders
// ---------------------------------------------------------------------------

function makeSelect(
  customId: string,
  placeholder: string,
  options: string[],
  currentValue: string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      options.map((opt) => ({
        label: opt.length > 100 ? opt.slice(0, 97) + "…" : opt,
        value: opt,
        default: opt === currentValue,
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildSelectRows(
  options: ComfyOptions,
  draft: DraftParams,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return [
    makeSelect(CUSTOM_ID.SELECT_MODEL, "Select model…", options.models, draft.model),
    makeSelect(CUSTOM_ID.SELECT_SAMPLER, "Select sampler…", options.samplers, draft.sampler),
    makeSelect(CUSTOM_ID.SELECT_SCHEDULER, "Select scheduler…", options.schedulers, draft.scheduler),
  ];
}

export function buildButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID.BTN_EDIT_PROMPTS)
      .setLabel("Edit Prompts")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID.BTN_GENERATE)
      .setLabel("Generate")
      .setStyle(ButtonStyle.Primary),
  );
}

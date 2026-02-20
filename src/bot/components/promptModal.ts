import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { z } from "zod";
import { CUSTOM_ID, type DraftParams } from "./formEmbed.js";

/** Generate a random seed in the ComfyUI valid range (0–4 294 967 295). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 4_294_967_296);
}

export function buildPromptModal(draft: DraftParams): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_ID.MODAL_PROMPTS)
    .setTitle("Set Prompts & Parameters");

  const positiveInput = new TextInputBuilder()
    .setCustomId(CUSTOM_ID.MODAL_FIELD_POS)
    .setLabel("Positive Prompt")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500)
    .setValue(draft.positivePrompt);

  const negativeInput = new TextInputBuilder()
    .setCustomId(CUSTOM_ID.MODAL_FIELD_NEG)
    .setLabel("Negative Prompt")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(800)
    .setValue(draft.negativePrompt);

  const stepsInput = new TextInputBuilder()
    .setCustomId(CUSTOM_ID.MODAL_FIELD_STEPS)
    .setLabel("Steps (1–150)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3)
    .setValue(String(draft.steps));

  const cfgInput = new TextInputBuilder()
    .setCustomId(CUSTOM_ID.MODAL_FIELD_CFG)
    .setLabel("CFG Scale (1–30)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setValue(String(draft.cfg));

  const seedInput = new TextInputBuilder()
    .setCustomId(CUSTOM_ID.MODAL_FIELD_SEED)
    .setLabel("Seed (blank or 'random' = re-roll)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(10)
    .setValue(String(draft.seed));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(positiveInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(negativeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(stepsInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(cfgInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(seedInput),
  );

  return modal;
}

// ---------------------------------------------------------------------------
// Validation schema for modal fields
// ---------------------------------------------------------------------------

export const ModalSchema = z.object({
  positivePrompt: z.string().min(1, "Positive prompt cannot be empty.").max(1500),
  negativePrompt: z.string().max(800).default(""),
  steps: z.coerce
    .number()
    .int("Steps must be a whole number.")
    .min(1, "Steps must be at least 1.")
    .max(150, "Steps cannot exceed 150."),
  cfg: z.coerce
    .number()
    .min(1, "CFG must be at least 1.")
    .max(30, "CFG cannot exceed 30."),
  // Blank, whitespace-only, or the word "random" → generate a new random seed at parse time.
  // Otherwise parse as an integer in the ComfyUI valid range 0–4 294 967 295.
  seedRaw: z.string().default(""),
});

export type ModalValues = z.infer<typeof ModalSchema>;

/**
 * Resolve the raw seed string from `ModalSchema` into a concrete integer.
 * Blank / "random" → fresh random seed.
 * A valid integer string → that seed (clamped to 0–4 294 967 295).
 * Invalid (non-numeric) → returns null so the caller can surface an error.
 */
export function resolveSeed(seedRaw: string): number | null {
  const trimmed = seedRaw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "random") return randomSeed();
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4_294_967_295) return null;
  return parsed;
}

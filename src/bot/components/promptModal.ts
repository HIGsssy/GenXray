import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { z } from "zod";
import { CUSTOM_ID, type DraftParams } from "./formEmbed.js";

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

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(positiveInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(negativeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(stepsInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(cfgInput),
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
});

export type ModalValues = z.infer<typeof ModalSchema>;

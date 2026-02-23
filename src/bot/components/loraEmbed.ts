import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { z } from "zod";
import type { DraftParams } from "./formEmbed.js";

// ---------------------------------------------------------------------------
// Custom ID constants
// ---------------------------------------------------------------------------

export const LORA_CUSTOM_ID = {
  SELECT_PREFIX: "lora:select:",          // full: "lora:select:0" … "lora:select:3"
  BTN_BACK: "lora:back",
  BTN_STRENGTH: "lora:strength",
  MODAL_STRENGTH: "lora:strength:submit",
  MODAL_FIELD_PREFIX: "lora:strength:field:", // full: "lora:strength:field:0" etc.
} as const;

/** Sentinel value used for the "None" option in LoRA select menus (Discord requires value >= 1 char). */
export const LORA_NONE_VALUE = "__none__";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorten a LoRA filename into a human-readable label for Discord select menus. */
function loraLabel(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  return name.length > 97 ? name.slice(0, 97) + "…" : name;
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

export function buildLoraEmbed(draft: DraftParams): EmbedBuilder {
  const active = draft.loras
    .map((l, i) => ({ lora: l, slot: i + 1 }))
    .filter((x): x is { lora: NonNullable<typeof x.lora>; slot: number } => x.lora !== null);

  const embed = new EmbedBuilder()
    .setTitle("🎨 LoRA Selection")
    .setColor(0x9b59b6)
    .setDescription(
      active.length === 0
        ? "No LoRAs selected. Use the menus below to pick up to 4 LoRAs."
        : active
            .map(({ lora, slot }) => {
              const tw =
                lora.triggerWords.length > 0
                  ? lora.triggerWords.map((w) => `\`${w}\``).join(", ")
                  : "_None found_";
              return `**Slot ${slot}:** ${loraLabel(lora.name)} (strength: ${lora.strength.toFixed(1)})\nTrigger words: ${tw}`;
            })
            .join("\n\n"),
    );

  return embed;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function buildLoraComponents(
  draft: DraftParams,
  loraOptions: string[],
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const truncated = loraOptions.slice(0, 24); // Discord cap: 25 options (1 "None" + 24 filenames)

  const selectRows = [0, 1, 2, 3].map((i) => {
    const current = draft.loras[i];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${LORA_CUSTOM_ID.SELECT_PREFIX}${i}`)
      .setPlaceholder(`LoRA Slot ${i + 1}`)
      .addOptions([
        {
          label: "None",
          value: LORA_NONE_VALUE,
          description: "Remove LoRA from this slot",
          default: current === null,
        },
        ...truncated.map((filename) => ({
          label: loraLabel(filename),
          value: filename,
          default: current?.name === filename,
        })),
      ]);
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  });

  const hasActive = draft.loras.some(Boolean);
  const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(LORA_CUSTOM_ID.BTN_BACK)
      .setLabel("← Back to Settings")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(LORA_CUSTOM_ID.BTN_STRENGTH)
      .setLabel("⚙️ Set Strengths")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasActive),
  );

  return [...selectRows, btnRow];
}

// ---------------------------------------------------------------------------
// Strength modal
// ---------------------------------------------------------------------------

export const LoraStrengthSchema = z.coerce
  .number()
  .min(0.1, "Minimum strength is 0.1")
  .max(3.0, "Maximum strength is 3.0");

export function buildLoraStrengthModal(draft: DraftParams): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(LORA_CUSTOM_ID.MODAL_STRENGTH)
    .setTitle("Set LoRA Strengths");

  const activeSlots = draft.loras
    .map((l, i) => ({ lora: l, index: i }))
    .filter((x): x is { lora: NonNullable<typeof x.lora>; index: number } => x.lora !== null);

  for (const { lora, index } of activeSlots) {
    const input = new TextInputBuilder()
      .setCustomId(`${LORA_CUSTOM_ID.MODAL_FIELD_PREFIX}${index}`)
      .setLabel(`Slot ${index + 1}: ${loraLabel(lora.name).slice(0, 37)}`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(5)
      .setPlaceholder("0.1 – 3.0")
      .setValue(lora.strength.toFixed(1));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  return modal;
}

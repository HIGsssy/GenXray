import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

export const BANNED_EDIT_CUSTOM_ID = "banned:edit";

/**
 * Builds the red warning embed shown when a prompt is rejected.
 */
export function buildBannedWordEmbed(matchedWords: string[]): EmbedBuilder {
  const list = matchedWords.map((w) => `• ||${w}||`).join("\n");
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("⛔ Prompt Rejected")
    .setDescription(`Your prompt contains the following banned term(s):\n${list}`)
    .setFooter({ text: "Please edit your prompt and try again." });
}

/**
 * Builds an action row containing the "✏️ Edit Prompt" button to re-open the modal.
 */
export function buildBannedEditButtonRow(): ActionRowBuilder<ButtonBuilder> {
  const btn = new ButtonBuilder()
    .setCustomId(BANNED_EDIT_CUSTOM_ID)
    .setLabel("✏️ Edit Prompt")
    .setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(btn);
}

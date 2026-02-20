import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../../config.js";
import { fetchOptions } from "../../comfy/objectInfo.js";
import { initDraft } from "../components/formEmbed.js";
import { buildPromptModal } from "../components/promptModal.js";
import { logger } from "../../logger.js";

export const data = new SlashCommandBuilder()
  .setName("gen")
  .setDescription("Generate an image using ComfyUI");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Channel guard
  if (!config.discord.allowedChannelIds.includes(interaction.channelId)) {
    await interaction.reply({
      content: "This command can only be used in designated generation channels.",
      ephemeral: true,
    });
    return;
  }

  let options;
  try {
    options = await fetchOptions();
  } catch (err) {
    logger.error({ err }, "/gen: failed to fetch ComfyUI options");
    await interaction.reply({
      content: "ComfyUI is not reachable or is not properly configured. Please try again later.",
      ephemeral: true,
    });
    return;
  }

  // Initialise draft with defaults, then immediately open the prompts modal.
  // The main embed (dropdowns + Generate) appears after the user submits the modal.
  const draft = initDraft(interaction.user.id, options);
  await interaction.showModal(buildPromptModal(draft));
}

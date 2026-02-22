import { SlashCommandBuilder, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../../config.js";
import { purgeOldJobs } from "../../db/purge.js";

export const data = new SlashCommandBuilder()
  .setName("purge")
  .setDescription("Immediately purge old completed/failed job records (bot owner only)")
  .addIntegerOption((opt) =>
    opt
      .setName("hours")
      .setDescription("Delete records older than this many hours (default: PURGE_MAX_AGE_HOURS)")
      .setMinValue(0)
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.user.id !== config.ownerId) {
    await interaction.reply({ content: "⛔ You are not authorised to use this command.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const hours = interaction.options.getInteger("hours") ?? config.purge.maxAgeHours;
  const maxAgeMs = hours * 60 * 60 * 1000;

  const result = purgeOldJobs(maxAgeMs);

  const cutoffDate = new Date(Date.now() - maxAgeMs).toUTCString();
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🗑️ Purge Complete")
    .addFields(
      { name: "Jobs deleted", value: String(result.jobsDeleted), inline: true },
      { name: "Upscale jobs deleted", value: String(result.upscaleJobsDeleted), inline: true },
      { name: "Cutoff", value: cutoffDate, inline: false }
    );

  await interaction.editReply({ embeds: [embed] });
}

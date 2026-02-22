import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { config } from "../../config.js";
import { addBannedWord, removeBannedWord, listBannedWords } from "../../db/bannedWords.js";

export const data = new SlashCommandBuilder()
  .setName("banned")
  .setDescription("Manage the banned word list (bot owner only)")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a word or phrase to the banned list")
      .addStringOption((opt) =>
        opt
          .setName("word")
          .setDescription("The word or phrase to ban")
          .setRequired(true)
      )
      .addBooleanOption((opt) =>
        opt
          .setName("partial")
          .setDescription("Match as a substring (default: whole-word only)")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove a word from the banned list")
      .addStringOption((opt) =>
        opt
          .setName("word")
          .setDescription("The word or phrase to unban")
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Show all currently banned words")
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Gate to bot owner only
  if (interaction.user.id !== config.ownerId) {
    await interaction.reply({ content: "⛔ You are not authorised to use this command.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "add") {
    const word = interaction.options.getString("word", true).trim();
    const partial = interaction.options.getBoolean("partial") ?? false;
    if (!word) {
      await interaction.reply({ content: "Word cannot be empty.", ephemeral: true });
      return;
    }
    addBannedWord(word, partial, interaction.user.id);
    await interaction.reply({
      content: `✅ **${word}** has been added to the banned list (match mode: ${partial ? "partial" : "whole-word"}).`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "remove") {
    const word = interaction.options.getString("word", true).trim();
    const removed = removeBannedWord(word);
    if (removed) {
      await interaction.reply({ content: `✅ **${word}** has been removed from the banned list.`, ephemeral: true });
    } else {
      await interaction.reply({ content: `⚠️ **${word}** was not found in the banned list.`, ephemeral: true });
    }
    return;
  }

  if (sub === "list") {
    const words = listBannedWords();
    if (words.length === 0) {
      await interaction.reply({ content: "The banned word list is currently empty.", ephemeral: true });
      return;
    }

    const PAGE_SIZE = 20;
    const page = words.slice(0, PAGE_SIZE);
    const lines = page.map(
      (w) => `• ||${w.word}|| — ${w.partial ? "partial" : "whole-word"} (added by <@${w.addedBy}> on ${w.addedAt.slice(0, 10)})`
    );
    const embed = new EmbedBuilder()
      .setTitle("⛔ Banned Word List")
      .setColor(0xe74c3c)
      .setDescription(lines.join("\n"))
      .setFooter({
        text: words.length > PAGE_SIZE
          ? `Showing ${PAGE_SIZE} of ${words.length} entries.`
          : `${words.length} entr${words.length === 1 ? "y" : "ies"} total.`,
      });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
}

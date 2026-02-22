/**
 * Register slash commands scoped to the development guild.
 * Run with: npm run deploy-commands
 */
import { REST, Routes } from "discord.js";
import { config } from "../config.js";
import { data as genCommand } from "../bot/commands/gen.js";
import { data as bannedCommand } from "../bot/commands/banned.js";
import { data as purgeCommand } from "../bot/commands/purge.js";
import { logger } from "../logger.js";

const rest = new REST({ version: "10" }).setToken(config.discord.token);

const commands = [genCommand.toJSON(), bannedCommand.toJSON(), purgeCommand.toJSON()];

logger.info(
  { guildId: config.discord.guildId, commandCount: commands.length },
  "Deploying guild-scoped slash commands…",
);

rest
  .put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
    body: commands,
  })
  .then(() => {
    logger.info("Slash commands registered successfully.");
  })
  .catch((err) => {
    logger.error({ err }, "Failed to register slash commands");
    process.exit(1);
  });

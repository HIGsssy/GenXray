import type { Client } from "discord.js";
import { logger } from "../../logger.js";
import { config } from "../../config.js";

export function onReady(client: Client): void {
  logger.info(
    {
      tag: client.user?.tag,
      allowedChannels: config.discord.allowedChannelIds,
    },
    "Bot ready",
  );
}

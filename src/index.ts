import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getDb, closeDb } from "./db/database.js";
import { comfyClient } from "./comfy/client.js";
import { fetchOptions } from "./comfy/objectInfo.js";
import { loadBaseWorkflow, validate as validateWorkflow } from "./comfy/workflowBinder.js";
import { validateUpscaleWorkflows } from "./comfy/upscaleBinder.js";
import { setDiscordClient } from "./queue/jobQueue.js";
import { startPurgeScheduler } from "./queue/purgeScheduler.js";
import { onInteractionCreate } from "./bot/events/interactionCreate.js";
import { onReady } from "./bot/events/ready.js";

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

async function startup(): Promise<void> {
  logger.info("ComfyGen starting up…");

  // 1. Database
  getDb();

  // 2. Start purge scheduler (runs first purge after 60 s)
  startPurgeScheduler();

  // 3. Validate base workflow exists and is structurally valid
  logger.info("Validating base workflow…");
  let baseWorkflow: Record<string, unknown>;
  try {
    baseWorkflow = loadBaseWorkflow();
  } catch (err) {
    logger.fatal({ err }, "Could not load workflows/multisampler/base.json — cannot start");
    process.exit(1);
  }

  const wfResult = validateWorkflow(baseWorkflow);
  if (!wfResult.ok) {
    logger.fatal({ reason: wfResult.reason }, "base.json failed validation — cannot start");
    process.exit(1);
  }
  logger.info("base.json OK");

  // 4. Validate upscale workflows
  logger.info("Validating upscale workflows…");
  const upscaleResult = validateUpscaleWorkflows();
  if (!upscaleResult.ok) {
    logger.fatal({ reason: upscaleResult.reason }, "Upscale workflow validation failed — cannot start");
    process.exit(1);
  }
  logger.info(`Upscale workflows OK (active: ${config.upscale.workflow})`);

  // 5. Ping ComfyUI
  logger.info({ url: config.comfy.baseUrl }, "Pinging ComfyUI…");
  const alive = await comfyClient.ping();
  if (!alive) {
    logger.fatal({ url: config.comfy.baseUrl }, "ComfyUI is unreachable — cannot start");
    process.exit(1);
  }
  logger.info("ComfyUI reachable");

  // 6. Fetch and validate option lists (also validates node class detection)
  logger.info("Fetching ComfyUI object_info…");
  try {
    await fetchOptions();
  } catch (err) {
    logger.fatal({ err }, "Failed to fetch ComfyUI options — cannot start");
    process.exit(1);
  }

  // 7. Build Discord client
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  setDiscordClient(client);

  client.once("ready", () => onReady(client));
  client.on("interactionCreate", onInteractionCreate);

  client.on("error", (err) => logger.error({ err }, "Discord client error"));

  await client.login(config.discord.token);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down…");
  closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

startup().catch((err) => {
  logger.fatal({ err }, "Startup failed");
  process.exit(1);
});

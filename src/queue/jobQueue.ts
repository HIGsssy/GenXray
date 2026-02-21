import type { TextChannel, ButtonBuilder, InteractionWebhook } from "discord.js";
import { comfyClient } from "../comfy/client.js";
import { bind } from "../comfy/workflowBinder.js";
import { bindUpscale } from "../comfy/upscaleBinder.js";
import { getJobOrThrow, setJobRunning, setJobCompleted, setJobFailed } from "../db/jobs.js";
import {
  insertUpscaleJob as _insertUpscaleJob,
  getUpscaleJobOrThrow,
  setUpscaleJobRunning,
  setUpscaleJobCompleted,
  setUpscaleJobFailed,
} from "../db/upscaleJobs.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Simple FIFO in-memory queue (job IDs only; source of truth is DB)
// ---------------------------------------------------------------------------

interface QueueEntry {
  jobId: string;
  type: "gen" | "upscale";
}

const _queue: QueueEntry[] = [];
let _running = false;
let _client: import("discord.js").Client | null = null;

/** Ephemeral interaction webhooks keyed by jobId — valid for 15 min after interaction. */
const _webhooks = new Map<string, InteractionWebhook>();

export function setDiscordClient(client: import("discord.js").Client): void {
  _client = client;
}

export function enqueue(jobId: string, webhook?: InteractionWebhook): number {
  _queue.push({ jobId, type: "gen" });
  if (webhook) _webhooks.set(jobId, webhook);
  logger.info({ jobId, type: "gen", queueLength: _queue.length }, "Job enqueued");
  scheduleRun();
  return _queue.length;
}

export function enqueueUpscale(jobId: string, webhook?: InteractionWebhook): number {
  _queue.push({ jobId, type: "upscale" });
  if (webhook) _webhooks.set(jobId, webhook);
  logger.info({ jobId, type: "upscale", queueLength: _queue.length }, "Upscale job enqueued");
  scheduleRun();
  return _queue.length;
}

export function queueLength(): number {
  return _queue.length;
}

/** Retrieve and remove the webhook for a job (one-shot). */
function consumeWebhook(jobId: string): InteractionWebhook | undefined {
  const wh = _webhooks.get(jobId);
  _webhooks.delete(jobId);
  return wh;
}

/** Fire-and-forget ephemeral status update. Swallows errors (token may be expired). */
async function editProgress(webhook: InteractionWebhook | undefined, content: string): Promise<void> {
  if (!webhook) return;
  try {
    await webhook.editMessage("@original", { content, embeds: [], components: [] });
  } catch {
    // Token expired or message already resolved — silently ignore
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function scheduleRun(): void {
  if (_running) return;
  setImmediate(runNext);
}

async function runNext(): Promise<void> {
  if (_running || _queue.length === 0) return;
  _running = true;

  const entry = _queue.shift()!;
  const { jobId, type } = entry;
  logger.info({ jobId, type }, "Runner: starting job");

  const webhook = consumeWebhook(jobId);

  try {
    if (type === "upscale") {
      await runUpscaleJob(jobId, webhook);
    } else {
      await runGenJob(jobId, webhook);
    }
  } finally {
    _running = false;
    if (_queue.length > 0) setImmediate(runNext);
  }
}

async function runGenJob(jobId: string, webhook: InteractionWebhook | undefined): Promise<void> {
  try {
    const job = getJobOrThrow(jobId);

    // Bind workflow
    const bindResult = bind(job);
    if (!bindResult.ok) {
      await setJobFailed(jobId, `Workflow bind failed: ${bindResult.reason}`);
      await notifyFailure(job.channelId, job.userId, jobId, bindResult.reason);
      void editProgress(webhook, "❌ Generation failed — see the error posted in the channel.");
      return;
    }

    // Submit to ComfyUI
    const { promptId } = await comfyClient.submitPrompt(bindResult.workflow);
    setJobRunning(jobId, promptId);
    void editProgress(webhook, "🔄 Generating your image… I'll mention you when it's ready.");

    // Poll for completion
    const images = await pollUntilDone(promptId, jobId);
    setJobCompleted(jobId, images);
    logger.info({ jobId, promptId, images: images.length }, "Runner: gen job completed");

    // Post results to Discord
    await postSuccess(job.channelId, job.userId, jobId, images);
    void editProgress(webhook, "✅ Done — your image has been posted below.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err: msg }, "Runner: gen job failed");
    void editProgress(webhook, "❌ Generation failed — see the error posted in the channel.");
    try {
      const job = getJobOrThrow(jobId);
      setJobFailed(jobId, msg);
      await notifyFailure(job.channelId, job.userId, jobId, "An unexpected error occurred.");
    } catch {
      // DB read may fail too; swallow
    }
  }
}

async function runUpscaleJob(jobId: string, webhook: InteractionWebhook | undefined): Promise<void> {
  try {
    const job = getUpscaleJobOrThrow(jobId);
    void editProgress(webhook, "🔄 Upscaling your image… I'll mention you when it's ready.");

    // Bind workflow (uploadedFilename already stored in job)
    const bindResult = bindUpscale(job, job.sourceImageFilename);
    if (!bindResult.ok) {
      setUpscaleJobFailed(jobId, `Workflow bind failed: ${bindResult.reason}`);
      await notifyUpscaleFailure(job.channelId, job.userId, jobId, bindResult.reason);
      void editProgress(webhook, "❌ Upscale failed — see the error posted in the channel.");
      return;
    }

    // Submit to ComfyUI
    const { promptId } = await comfyClient.submitPrompt(bindResult.workflow);
    setUpscaleJobRunning(jobId, promptId);

    // Poll for completion
    const images = await pollUntilDone(promptId, jobId);
    setUpscaleJobCompleted(jobId, images);
    logger.info({ jobId, promptId, images: images.length }, "Runner: upscale job completed");

    // Post results to Discord
    await postUpscaleSuccess(job.channelId, job.userId, jobId, images);
    void editProgress(webhook, "✅ Done — your upscaled image has been posted below.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err: msg }, "Runner: upscale job failed");
    void editProgress(webhook, "❌ Upscale failed — see the error posted in the channel.");
    try {
      const job = getUpscaleJobOrThrow(jobId);
      setUpscaleJobFailed(jobId, msg);
      await notifyUpscaleFailure(job.channelId, job.userId, jobId, "An unexpected error occurred.");
    } catch {
      // swallow
    }
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function pollUntilDone(promptId: string, jobId: string): Promise<string[]> {
  const deadline = Date.now() + config.comfy.timeoutMs;
  const POLL_INTERVAL = 2_000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const entry = await comfyClient.getHistory(promptId);

    if (!entry) continue;
    if (!entry.status.completed) continue;

    // Collect all image filenames across all output nodes
    const files: string[] = [];
    for (const outputNode of Object.values(entry.outputs)) {
      for (const img of outputNode.images ?? []) {
        files.push(img.filename);
      }
    }

    if (files.length === 0) {
      logger.warn({ promptId, jobId }, "ComfyUI reported completed but no images found in outputs");
    }
    return files;
  }

  throw new Error(`Job timed out after ${config.comfy.timeoutMs / 1000}s (ComfyUI prompt ${promptId})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Discord notifications
// ---------------------------------------------------------------------------

async function postSuccess(
  channelId: string,
  userId: string,
  jobId: string,
  imageFilenames: string[],
): Promise<void> {
  if (!_client) return;
  try {
    const channel = (await _client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    const job = getJobOrThrow(jobId);
    const { EmbedBuilder, AttachmentBuilder } = await import("discord.js");

    const discordUser = await _client.users.fetch(userId).catch(() => null);
    const displayName = discordUser?.displayName ?? "Unknown User";

    const attachments = await Promise.all(
      imageFilenames.map(async (filename) => {
        const entry = await comfyClient.getHistory(job.comfyPromptId!);
        // Find subfolder/type for this filename
        let subfolder = "";
        let type = "output";
        if (entry) {
          for (const out of Object.values(entry.outputs)) {
            const img = (out.images ?? []).find((i) => i.filename === filename);
            if (img) {
              subfolder = img.subfolder;
              type = img.type;
              break;
            }
          }
        }
        const buf = await comfyClient.getImage(filename, subfolder, type);
        return new AttachmentBuilder(buf, { name: filename });
      }),
    );

    const truncPrompt =
      job.positivePrompt.length > 200
        ? job.positivePrompt.slice(0, 197) + "…"
        : job.positivePrompt;

    const embed = new EmbedBuilder()
      .setTitle(`Image generated by ${displayName}`)
      .setColor(0x5865f2)
      .addFields(
        { name: "Model", value: job.model, inline: true },
        { name: "Sampler", value: job.sampler, inline: true },
        { name: "Scheduler", value: job.scheduler, inline: true },
        { name: "Steps", value: String(job.steps), inline: true },
        { name: "CFG", value: String(job.cfg), inline: true },
        { name: "Seed", value: String(job.seed), inline: true },
        { name: "Size", value: job.size, inline: true },
      )
      .setFooter({ text: "Prompt hidden — requester can click Share Prompt to reveal" });

    if (attachments.length > 0) {
      embed.setImage(`attachment://${attachments[0].name}`);
    }

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
    const { CUSTOM_ID } = await import("../bot/components/formEmbed.js");

    const shareButton = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID.SHARE_PROMPT_PREFIX}:${jobId}`)
      .setLabel("Share Prompt")
      .setStyle(ButtonStyle.Secondary);

    const rerollButton = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID.REROLL_PREFIX}:${jobId}`)
      .setLabel("🎲 Re-roll")
      .setStyle(ButtonStyle.Primary);

    const editButton = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID.EDIT_PREFIX}:${jobId}`)
      .setLabel("✏️ Edit")
      .setStyle(ButtonStyle.Secondary);

    const deleteButton = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID.DELETE_PREFIX}:${jobId}`)
      .setLabel("🗑️ Delete")
      .setStyle(ButtonStyle.Danger);

    const upscaleButton = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID.UPSCALE_PREFIX}:${jobId}`)
      .setLabel("⬆️ Upscale")
      .setStyle(ButtonStyle.Success);

    const shareRow = new ActionRowBuilder<ButtonBuilder>().addComponents(shareButton, rerollButton, editButton, upscaleButton, deleteButton);

    await channel.send({
      content: `<@${userId}>`,
      embeds: [embed],
      files: attachments,
      components: [shareRow],
    });
  } catch (err) {
    logger.error({ jobId, err }, "Failed to post completion to Discord");
  }
}

async function notifyFailure(
  channelId: string,
  userId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  if (!_client) return;
  try {
    const channel = (await _client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    const { EmbedBuilder } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle("Generation failed")
      .setColor(0xed4245)
      .setDescription(reason)
      .setFooter({ text: `Job ID: ${jobId}` });

    await channel.send({ content: `<@${userId}>`, embeds: [embed] });
  } catch (err) {
    logger.error({ jobId, err }, "Failed to post failure notice to Discord");
  }
}

async function postUpscaleSuccess(
  channelId: string,
  userId: string,
  jobId: string,
  imageFilenames: string[],
): Promise<void> {
  if (!_client) return;
  try {
    const channel = (await _client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    const job = getUpscaleJobOrThrow(jobId);
    const { EmbedBuilder, AttachmentBuilder } = await import("discord.js");

    const discordUser = await _client.users.fetch(userId).catch(() => null);
    const displayName = discordUser?.displayName ?? "Unknown User";

    const attachments = await Promise.all(
      imageFilenames.map(async (filename) => {
        const entry = await comfyClient.getHistory(job.comfyPromptId!);
        let subfolder = "";
        let type = "output";
        if (entry) {
          for (const out of Object.values(entry.outputs)) {
            const img = (out.images ?? []).find((i) => i.filename === filename);
            if (img) {
              subfolder = img.subfolder;
              type = img.type;
              break;
            }
          }
        }
        const buf = await comfyClient.getImage(filename, subfolder, type);
        return new AttachmentBuilder(buf, { name: filename });
      }),
    );

    const embed = new EmbedBuilder()
      .setTitle(`Upscaled image by ${displayName}`)
      .setColor(0x57f287)
      .addFields(
        { name: "Model", value: job.model, inline: true },
        { name: "Upscale Model", value: job.upscaleModel, inline: true },
        { name: "Workflow", value: config.upscale.workflow, inline: true },
      )
      .setFooter({ text: `Source job: ${job.sourceJobId}` });

    if (attachments.length > 0) {
      embed.setImage(`attachment://${attachments[0].name}`);
    }

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
    const { CUSTOM_ID } = await import("../bot/components/formEmbed.js");

    const deleteButton = new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID.DELETE_PREFIX}:${jobId}`)
      .setLabel("🗑️ Delete")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(deleteButton);

    await channel.send({
      content: `<@${userId}>`,
      embeds: [embed],
      files: attachments,
      components: [row],
    });
  } catch (err) {
    logger.error({ jobId, err }, "Failed to post upscale completion to Discord");
  }
}

async function notifyUpscaleFailure(
  channelId: string,
  userId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  if (!_client) return;
  try {
    const channel = (await _client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    const { EmbedBuilder } = await import("discord.js");
    const embed = new EmbedBuilder()
      .setTitle("Upscale failed")
      .setColor(0xed4245)
      .setDescription(reason)
      .setFooter({ text: `Upscale job ID: ${jobId}` });

    await channel.send({ content: `<@${userId}>`, embeds: [embed] });
  } catch (err) {
    logger.error({ jobId, err }, "Failed to post upscale failure notice to Discord");
  }
}

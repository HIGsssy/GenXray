import type { Interaction, ButtonBuilder } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { v4 as uuidv4 } from "uuid";
import { execute as genExecute } from "../commands/gen.js";
import {
  CUSTOM_ID,
  buildFormEmbed,
  buildSelectRows,
  buildButtonRow,
  getDraft,
  mergeDraft,
  deleteDraft,
  initDraftFromJob,
} from "../components/formEmbed.js";
import { buildPromptModal, ModalSchema, resolveSeed, randomSeed } from "../components/promptModal.js";
import { fetchOptions } from "../../comfy/objectInfo.js";
import { validate as validateWorkflow, bind } from "../../comfy/workflowBinder.js";
import { insertJob, countQueuedBefore, getJobOrThrow } from "../../db/jobs.js";
import { insertUpscaleJob, countUpscaleQueuedBefore } from "../../db/upscaleJobs.js";
import { enqueue, enqueueUpscale } from "../../queue/jobQueue.js";
import { comfyClient } from "../../comfy/client.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { JobParams, ImageSize } from "../../queue/types.js";

export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Slash command: /gen
  // ---------------------------------------------------------------------------
  if (interaction.isChatInputCommand() && interaction.commandName === "gen") {
    await genExecute(interaction);
    return;
  }

  // ---------------------------------------------------------------------------
  // 2. String select menus
  // ---------------------------------------------------------------------------
  if (interaction.isStringSelectMenu()) {
    const userId = interaction.user.id;
    const draft = getDraft(userId);
    if (!draft) {
      await interaction.reply({ content: "Your session has expired. Run `/gen` again.", ephemeral: true });
      return;
    }

    if (interaction.customId === CUSTOM_ID.SELECT_MODEL) {
      mergeDraft(userId, { model: interaction.values[0] });
    } else if (interaction.customId === CUSTOM_ID.SELECT_SAMPLER) {
      mergeDraft(userId, { sampler: interaction.values[0] });
    } else if (interaction.customId === CUSTOM_ID.SELECT_SCHEDULER) {
      mergeDraft(userId, { scheduler: interaction.values[0] });
    } else if (interaction.customId === CUSTOM_ID.SELECT_SIZE) {
      mergeDraft(userId, { size: interaction.values[0] as ImageSize });
    } else {
      return; // not ours
    }

    const updated = getDraft(userId)!;
    const options = await fetchOptions();

    await interaction.update({
      embeds: [buildFormEmbed(updated)],
      components: [...buildSelectRows(options, updated), buildButtonRow()],
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Buttons
  // ---------------------------------------------------------------------------
  if (interaction.isButton()) {
    const userId = interaction.user.id;

    if (interaction.customId === CUSTOM_ID.BTN_EDIT_PROMPTS) {
      const draft = getDraft(userId);
      if (!draft) {
        await interaction.reply({ content: "Your session has expired. Run `/gen` again.", ephemeral: true });
        return;
      }
      await interaction.showModal(buildPromptModal(draft));
      return;
    }

    if (interaction.customId === CUSTOM_ID.BTN_GENERATE) {
      const draft = getDraft(userId);
      if (!draft) {
        await interaction.reply({ content: "Your session has expired. Run `/gen` again.", ephemeral: true });
        return;
      }

      // Validate positive prompt is set
      if (!draft.positivePrompt.trim()) {
        await interaction.reply({
          content: "Please set a positive prompt before generating. Use **Edit Prompts**.",
          ephemeral: true,
        });
        return;
      }

      // Pre-submission workflow validation
      const loadBase = (await import("../../comfy/workflowBinder.js")).loadBaseWorkflow;
      const wfValidation = validateWorkflow(loadBase());
      if (!wfValidation.ok) {
        logger.error({ reason: wfValidation.reason }, "Workflow validation failed at generate click");
        await interaction.reply({
          content: `Workflow configuration error: ${wfValidation.reason} — please contact the bot administrator.`,
          ephemeral: true,
        });
        return;
      }

      // Build full JobParams
      if (!interaction.guildId) {
        await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        return;
      }

      const params: JobParams = {
        userId,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        model: draft.model,
        sampler: draft.sampler,
        scheduler: draft.scheduler,
        steps: draft.steps,
        cfg: draft.cfg,
        seed: draft.seed,
        size: draft.size,
        positivePrompt: draft.positivePrompt,
        negativePrompt: draft.negativePrompt,
      };

      // Final bind validation with actual values
      const tempJob: typeof params & { id: string; discordMessageId: null; status: "queued"; comfyPromptId: null; outputImages: null; errorMessage: null; createdAt: number; startedAt: null; completedAt: null } = {
        ...params,
        id: "preview",
        discordMessageId: null,
        status: "queued" as const,
        comfyPromptId: null,
        outputImages: null,
        errorMessage: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
      };
      const bindCheck = bind(tempJob);
      if (!bindCheck.ok) {
        await interaction.reply({
          content: `Cannot submit job — workflow bind error: ${bindCheck.reason}`,
          ephemeral: true,
        });
        return;
      }

      // Persist and enqueue
      const jobId = uuidv4();
      insertJob(jobId, params);
      const position = countQueuedBefore(jobId) + 1;

      // Acknowledge the button click first, then hand the webhook to the runner
      // so it can edit this same ephemeral as the job progresses.
      const queuedMsg =
        position === 1
          ? "⏳ Queued — you're next! I'll update this message as your job runs."
          : `⏳ Queued — position **${position}** in the queue. I'll update this message as your job runs.`;

      await interaction.update({ content: queuedMsg, embeds: [], components: [] });
      enqueue(jobId, interaction.webhook);
      deleteDraft(userId);

      logger.info({ jobId, userId, position }, "Job submitted by user");
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Share Prompt button on output posts
  // ---------------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith(CUSTOM_ID.SHARE_PROMPT_PREFIX + ":")
  ) {
    const jobId = interaction.customId.slice(CUSTOM_ID.SHARE_PROMPT_PREFIX.length + 1);

    let job;
    try {
      const { getJobOrThrow } = await import("../../db/jobs.js");
      job = getJobOrThrow(jobId);
    } catch {
      await interaction.reply({ content: "Could not find the job for this image.", ephemeral: true });
      return;
    }

    // Only the original requester may reveal the prompt
    if (interaction.user.id !== job.userId) {
      await interaction.reply({
        content: `Only <@${job.userId}> can share the prompt for this generation.`,
        ephemeral: true,
      });
      return;
    }

    const { EmbedBuilder } = await import("discord.js");
    const truncPos =
      job.positivePrompt.length > 1000
        ? job.positivePrompt.slice(0, 997) + "…"
        : job.positivePrompt;

    const revealedEmbed = new EmbedBuilder()
      .setTitle(`Image generated by ${interaction.user.displayName}`)
      .setColor(0x5865f2)
      .addFields(
        { name: "Model", value: job.model, inline: true },
        { name: "Sampler", value: job.sampler, inline: true },
        { name: "Scheduler", value: job.scheduler, inline: true },
        { name: "Steps", value: String(job.steps), inline: true },
        { name: "CFG", value: String(job.cfg), inline: true },
        { name: "Positive Prompt", value: truncPos },
        ...(job.negativePrompt
          ? [{ name: "Negative Prompt", value: job.negativePrompt.slice(0, 500) }]
          : []),
      );

    // Preserve the image attachment reference from the original embed
    const existingImage = interaction.message.embeds[0]?.image?.url;
    if (existingImage) revealedEmbed.setImage(existingImage);

    // Rebuild Re-roll, Edit, and Delete buttons so they survive the prompt reveal
    const { ActionRowBuilder, ButtonBuilder: BtnBuilder, ButtonStyle } = await import("discord.js");
    const rerollBtn = new BtnBuilder()
      .setCustomId(`${CUSTOM_ID.REROLL_PREFIX}:${jobId}`)
      .setLabel("🎲 Re-roll")
      .setStyle(ButtonStyle.Primary);
    const editBtn = new BtnBuilder()
      .setCustomId(`${CUSTOM_ID.EDIT_PREFIX}:${jobId}`)
      .setLabel("✏️ Edit")
      .setStyle(ButtonStyle.Secondary);
    const deleteBtn = new BtnBuilder()
      .setCustomId(`${CUSTOM_ID.DELETE_PREFIX}:${jobId}`)
      .setLabel("🗑️ Delete")
      .setStyle(ButtonStyle.Danger);
    const survivingButtons: InstanceType<typeof BtnBuilder>[] = [rerollBtn, editBtn];
    if (config.upscale.enabled) {
      const upscaleBtn = new BtnBuilder()
        .setCustomId(`${CUSTOM_ID.UPSCALE_PREFIX}:${jobId}`)
        .setLabel("⬆️ Upscale")
        .setStyle(ButtonStyle.Success);
      survivingButtons.push(upscaleBtn);
    }
    survivingButtons.push(deleteBtn);
    const survivingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...survivingButtons);

    // Edit the post in-place; remove Share Prompt, keep Re-roll + Edit + Delete
    await interaction.update({ embeds: [revealedEmbed], components: [survivingRow] });
    return;
  }

  // ---------------------------------------------------------------------------
  // 5. Re-roll button on output posts
  // ---------------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith(CUSTOM_ID.REROLL_PREFIX + ":")
  ) {
    const jobId = interaction.customId.slice(CUSTOM_ID.REROLL_PREFIX.length + 1);

    let originalJob;
    try {
      originalJob = getJobOrThrow(jobId);
    } catch {
      await interaction.reply({ content: "Could not find the original job.", ephemeral: true });
      return;
    }

    // Only the original requester may re-roll
    if (interaction.user.id !== originalJob.userId) {
      await interaction.reply({
        content: `Only <@${originalJob.userId}> can re-roll this generation.`,
        ephemeral: true,
      });
      return;
    }

    const newJobId = uuidv4();
    const params: JobParams = {
      userId: originalJob.userId,
      guildId: originalJob.guildId,
      channelId: originalJob.channelId,
      model: originalJob.model,
      sampler: originalJob.sampler,
      scheduler: originalJob.scheduler,
      steps: originalJob.steps,
      cfg: originalJob.cfg,
      seed: randomSeed(),
      size: originalJob.size,
      positivePrompt: originalJob.positivePrompt,
      negativePrompt: originalJob.negativePrompt,
    };

    insertJob(newJobId, params);
    const position = countQueuedBefore(newJobId) + 1;
    const queuedMsg =
      position === 1
        ? "⏳ Queued — you're next! I'll update this message as your job runs."
        : `⏳ Queued — position **${position}** in the queue. I'll update this message as your job runs.`;

    await interaction.reply({ content: queuedMsg, ephemeral: true });
    enqueue(newJobId, interaction.webhook);
    logger.info({ newJobId, originalJobId: jobId, userId: originalJob.userId }, "Re-roll submitted");
    return;
  }

  // ---------------------------------------------------------------------------
  // 6. Delete button on output posts
  // ---------------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith(CUSTOM_ID.DELETE_PREFIX + ":")
  ) {
    const jobId = interaction.customId.slice(CUSTOM_ID.DELETE_PREFIX.length + 1);

    let job;
    try {
      job = getJobOrThrow(jobId);
    } catch {
      await interaction.reply({ content: "Could not find the job for this image.", ephemeral: true });
      return;
    }

    const isRequester = interaction.user.id === job.userId;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
    if (!isRequester && !isAdmin) {
      await interaction.reply({
        content: "Only the original requester or server moderators can delete this post.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();
    await interaction.message.delete();
    return;
  }

  // ---------------------------------------------------------------------------
  // 7. Edit button on output posts
  // ---------------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith(CUSTOM_ID.EDIT_PREFIX + ":")
  ) {
    const jobId = interaction.customId.slice(CUSTOM_ID.EDIT_PREFIX.length + 1);

    let job;
    try {
      job = getJobOrThrow(jobId);
    } catch {
      await interaction.reply({ content: "Could not find the job for this image.", ephemeral: true });
      return;
    }

    if (interaction.user.id !== job.userId) {
      await interaction.reply({
        content: `Only <@${job.userId}> can edit this generation.`,
        ephemeral: true,
      });
      return;
    }

    const draft = initDraftFromJob(interaction.user.id, job);
    const editOptions = await fetchOptions();
    await interaction.reply({
      ephemeral: true,
      embeds: [buildFormEmbed(draft)],
      components: [...buildSelectRows(editOptions, draft), buildButtonRow()],
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // 8. Upscale button on output posts
  // ---------------------------------------------------------------------------
  if (
    interaction.isButton() &&
    interaction.customId.startsWith(CUSTOM_ID.UPSCALE_PREFIX + ":")
  ) {
    if (!config.upscale.enabled) {
      await interaction.reply({ content: "Upscaling is currently disabled.", ephemeral: true });
      return;
    }

    const jobId = interaction.customId.slice(CUSTOM_ID.UPSCALE_PREFIX.length + 1);

    let job;
    try {
      job = getJobOrThrow(jobId);
    } catch {
      await interaction.reply({ content: "Could not find the job for this image.", ephemeral: true });
      return;
    }

    if (interaction.user.id !== job.userId) {
      await interaction.reply({
        content: `Only <@${job.userId}> can upscale this image.`,
        ephemeral: true,
      });
      return;
    }

    if (job.status !== "completed" || !job.outputImages || job.outputImages.length === 0) {
      await interaction.reply({
        content: "This image is not available for upscaling yet.",
        ephemeral: true,
      });
      return;
    }

    // Defer — the image fetch + upload may take a few seconds
    await interaction.deferReply({ ephemeral: true });

    try {
      // Fetch the finished image from ComfyUI output folder
      const sourceFilename = job.outputImages[0];
      const history = await comfyClient.getHistory(job.comfyPromptId!);
      let subfolder = "";
      let imgType = "output";
      if (history) {
        for (const out of Object.values(history.outputs)) {
          const img = (out.images ?? []).find((i) => i.filename === sourceFilename);
          if (img) {
            subfolder = img.subfolder;
            imgType = img.type;
            break;
          }
        }
      }

      const imageBuffer = await comfyClient.getImage(sourceFilename, subfolder, imgType);

      // Upload to ComfyUI /upload/image so the workflow's image loader can read it
      const { name: uploadedFilename } = await comfyClient.uploadImage(imageBuffer, sourceFilename);

      // Create the upscale job in the DB
      if (!interaction.guildId) {
        await interaction.editReply({ content: "This command can only be used in a server." });
        return;
      }

      const upscaleJobId = uuidv4();
      insertUpscaleJob(upscaleJobId, {
        userId: job.userId,
        guildId: interaction.guildId,
        channelId: job.channelId,
        sourceJobId: job.id,
        sourceImageFilename: uploadedFilename,
        model: job.model,
        positivePrompt: job.positivePrompt,
        negativePrompt: job.negativePrompt,
        upscaleModel: config.upscale.model,
      });

      const position = countUpscaleQueuedBefore(upscaleJobId) + 1;
      const queuedMsg =
        position === 1
          ? `⏳ Queued for upscaling (${config.upscale.workflow} mode) — you're next! I'll update this message as it runs.`
          : `⏳ Queued for upscaling (${config.upscale.workflow} mode) — position **${position}** in the queue.`;

      await interaction.editReply({ content: queuedMsg });
      enqueueUpscale(upscaleJobId, interaction.webhook);

      logger.info({ upscaleJobId, sourceJobId: jobId, userId: job.userId }, "Upscale job submitted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId, err: msg }, "Failed to initiate upscale");
      await interaction.editReply({ content: `❌ Failed to start upscale: ${msg}` });
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // 9. Modal submit
  // ---------------------------------------------------------------------------
  if (interaction.isModalSubmit() && interaction.customId === CUSTOM_ID.MODAL_PROMPTS) {
    const userId = interaction.user.id;
    const draft = getDraft(userId);
    if (!draft) {
      await interaction.reply({ content: "Your session has expired. Run `/gen` again.", ephemeral: true });
      return;
    }

    const raw = {
      positivePrompt: interaction.fields.getTextInputValue(CUSTOM_ID.MODAL_FIELD_POS),
      negativePrompt: interaction.fields.getTextInputValue(CUSTOM_ID.MODAL_FIELD_NEG) || "",
      steps: interaction.fields.getTextInputValue(CUSTOM_ID.MODAL_FIELD_STEPS),
      cfg: interaction.fields.getTextInputValue(CUSTOM_ID.MODAL_FIELD_CFG),
      seedRaw: interaction.fields.getTextInputValue(CUSTOM_ID.MODAL_FIELD_SEED) || "",
    };

    const parsed = ModalSchema.safeParse(raw);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `• **${i.path.join(".")}**: ${i.message}`).join("\n");
      await interaction.reply({
        content: `Please fix the following errors:\n${errors}`,
        ephemeral: true,
      });
      return;
    }

    const resolvedSeed = resolveSeed(parsed.data.seedRaw);
    if (resolvedSeed === null) {
      await interaction.reply({
        content: "• **seed**: Must be a whole number between 0 and 4,294,967,295, or leave blank for random.",
        ephemeral: true,
      });
      return;
    }

    const updated = mergeDraft(userId, {
      positivePrompt: parsed.data.positivePrompt,
      negativePrompt: parsed.data.negativePrompt,
      steps: parsed.data.steps,
      cfg: parsed.data.cfg,
      seed: resolvedSeed,
    });

    const options = await fetchOptions();
    const embedPayload = {
      embeds: [buildFormEmbed(updated)],
      components: [...buildSelectRows(options, updated), buildButtonRow()],
    };

    // isFromMessage() is true when the modal was opened by the "Edit Prompts"
    // button (a message component). We can update the existing ephemeral in place.
    // When opened by /gen directly, reply() creates the embed for the first time.
    if (interaction.isFromMessage()) {
      await interaction.update(embedPayload);
    } else {
      await interaction.reply({ ...embedPayload, ephemeral: true });
    }
    return;
  }
}

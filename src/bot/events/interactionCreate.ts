import type { Interaction } from "discord.js";
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
} from "../components/formEmbed.js";
import { buildPromptModal, ModalSchema, resolveSeed } from "../components/promptModal.js";
import { fetchOptions } from "../../comfy/objectInfo.js";
import { validate as validateWorkflow, bind } from "../../comfy/workflowBinder.js";
import { insertJob, countQueuedBefore } from "../../db/jobs.js";
import { enqueue } from "../../queue/jobQueue.js";
import { logger } from "../../logger.js";
import type { JobParams } from "../../queue/types.js";

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
      .setTitle("Image generated")
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

    // Edit the post in-place; remove the button
    await interaction.update({ embeds: [revealedEmbed], components: [] });
    return;
  }

  // ---------------------------------------------------------------------------
  // 5. Modal submit
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

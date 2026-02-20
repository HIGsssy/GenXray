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
import { buildPromptModal, ModalSchema } from "../components/promptModal.js";
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
        positivePrompt: draft.positivePrompt,
        negativePrompt: draft.negativePrompt,
      };

      // Final bind validation with actual values
      const tempJob = {
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
      enqueue(jobId);
      deleteDraft(userId);

      await interaction.update({
        content: `✅ Queued! You are position **${position}** in the queue. I'll post your result in this channel.`,
        embeds: [],
        components: [],
      });

      logger.info({ jobId, userId, position }, "Job submitted by user");
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Modal submit
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

    const updated = mergeDraft(userId, {
      positivePrompt: parsed.data.positivePrompt,
      negativePrompt: parsed.data.negativePrompt,
      steps: parsed.data.steps,
      cfg: parsed.data.cfg,
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

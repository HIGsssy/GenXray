# Banned Word List Implementation Plan

**Goal:** Maintain a configurable list of banned words/phrases. Any `/gen` prompt containing a banned term is rejected before generation, a warning is shown to the user, and the user is given the opportunity to edit and resubmit the prompt.

---

## Decisions

- Banned words are stored in a SQLite table so they can be managed at runtime without redeploying.
- Matching is case-insensitive and whole-word aware (optional partial-match flag per entry).
- Both the **positive** and **negative** prompts are checked.
- On a match the bot responds with an ephemeral warning embed listing which terms were flagged and re-opens the prompt modal so the user can correct the text immediately.
- A bot-owner-only `/banned` slash command handles CRUD (add / remove / list).
- No generation job is created or queued when a banned word is detected.

---

## Step-by-Step Implementation

### 1. DB migration — new `migrations/006_banned_words.sql`

```sql
CREATE TABLE IF NOT EXISTS banned_words (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  word      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  partial   INTEGER NOT NULL DEFAULT 0,  -- 1 = substring match, 0 = whole-word only
  added_by  TEXT    NOT NULL,            -- Discord user ID of the admin who added it
  added_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Apply: `sqlite3 data/imggen.db < migrations/006_banned_words.sql`

---

### 2. DB layer — new `src/db/bannedWords.ts`

```ts
export interface BannedWord {
  id: number;
  word: string;
  partial: boolean;
  addedBy: string;
  addedAt: string;
}

export function addBannedWord(word: string, partial: boolean, addedBy: string): void
export function removeBannedWord(word: string): boolean          // returns false if not found
export function listBannedWords(): BannedWord[]
export function checkPrompt(text: string): string[]             // returns matched banned words
```

`checkPrompt()` logic:
- Load all rows from `banned_words`.
- For each row:
  - `partial = true` → `text.toLowerCase().includes(word.toLowerCase())`
  - `partial = false` → regex `\b<word>\b` with `i` flag
- Return the list of matched `word` strings (deduplicated).

Consider an in-process LRU cache of the word list with a short TTL (e.g. 30 seconds) to avoid a DB read on every generation attempt.

---

### 3. Prompt validation helper — new `src/bot/promptGuard.ts`

```ts
/**
 * Checks positive and negative prompts against the banned word list.
 * Returns an array of matched banned terms, or an empty array if clean.
 */
export function guardPrompt(positive: string, negative: string): string[]
```

- Calls `checkPrompt(positive)` and `checkPrompt(negative)`, merges and deduplicates results.
- Kept as a thin wrapper so the logic is easily unit-testable independent of Discord objects.

---

### 4. Warning embed — new `src/bot/components/bannedWordEmbed.ts`

```ts
export function buildBannedWordEmbed(matchedWords: string[]): EmbedBuilder
```

- Colour: red (`0xe74c3c`)
- Title: `⛔ Prompt Rejected`
- Description: `Your prompt contains the following banned term(s):`
- A bulleted field listing each matched term (terms are shown as `||spoiler||` tags to avoid re-displaying the exact word in public channels).
- Footer: `Please edit your prompt and try again.`

The embed is sent as part of an **ephemeral** reply so only the requesting user sees it.

---

### 5. Re-open prompt modal after rejection

After sending the warning embed the bot immediately opens the existing `promptModal` so the user can correct their prompt without having to re-invoke the command.

In `interactionCreate.ts`, the rejection flow is:

```ts
const hits = guardPrompt(draft.positivePrompt, draft.negativePrompt);
if (hits.length > 0) {
  await interaction.reply({
    embeds: [buildBannedWordEmbed(hits)],
    ephemeral: true,
  });
  // Re-open the prompt modal pre-populated with the current (rejected) text
  await interaction.followUp({
    components: [buildPromptModal(draft)],   // existing modal builder
    ephemeral: true,
  });
  return; // abort — do not enqueue
}
```

> **Note:** Discord does not allow opening a modal after a reply. The preferred UX is to include a **"Edit Prompt"** button on the ephemeral warning embed. When clicked it opens the existing prompt modal (a button interaction can `showModal()`).

Revised flow:

1. `interaction.reply({ embeds: [bannedWordEmbed], components: [editButtonRow], ephemeral: true })`
2. User clicks **✏️ Edit Prompt** button (customId `banned:edit`).
3. Handler calls `interaction.showModal(promptModal(draft))`.
4. User corrects the prompt and submits the modal as normal.

---

### 6. Interaction handler — `src/bot/events/interactionCreate.ts`

Add:

| customId | Action |
|---|---|
| `banned:edit` | `interaction.showModal(buildPromptModal(draft))` with draft pre-populated from the session |

The guard call is placed **immediately before** the `jobQueue.add()` call in the existing generate flow, so it intercepts both the initial generation and any re-roll/edit resubmissions.

---

### 7. `/banned` slash command — new `src/bot/commands/banned.ts`

Owner-only command (checked via `interaction.user.id === config.OWNER_ID`).

Subcommands:

| Subcommand | Options | Description |
|---|---|---|
| `add` | `word: string`, `partial?: boolean` | Adds a term to the list |
| `remove` | `word: string` | Removes a term |
| `list` | — | Shows all current banned terms (ephemeral) |

All responses are ephemeral. `list` paginates if there are more than 20 entries.

---

### 8. Config — `src/config.ts`

Add optional env var:

```ts
OWNER_ID: z.string().min(1),   // Discord user ID allowed to manage banned words
```

Used by the `/banned` command to gate access.

---

### 9. Deploy commands — `src/scripts/deployCommands.ts`

Register the new `/banned` command alongside existing commands.

---

## Data Flow Summary

```
User submits prompt modal
        │
        ▼
guardPrompt(positive, negative)
        │
   ┌────┴────┐
   │ matches │──yes──► ephemeral warning embed + "Edit Prompt" button
   └────┬────┘                  │
        │ no                    ▼
        │             User clicks "Edit Prompt"
        │                       │
        │             showModal(promptModal)  ──► re-enter flow from top
        ▼
  jobQueue.add(...)   ◄── generation proceeds normally
```

---

## Verification Checklist

- [ ] Run migration: `sqlite3 data/imggen.db < migrations/006_banned_words.sql`
- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] `/banned add word:test` adds the word and confirms ephemerally
- [ ] `/banned list` lists all current banned words
- [ ] `/banned remove word:test` removes the word and confirms
- [ ] Non-owner users get an "Unauthorised" ephemeral response for `/banned`
- [ ] Submitting a prompt containing a banned word shows the red warning embed (ephemeral)
- [ ] Warning embed lists the matched term(s)
- [ ] Clicking **✏️ Edit Prompt** on the warning re-opens the prompt modal pre-filled with the rejected text
- [ ] Correcting the prompt and resubmitting proceeds to generation normally
- [ ] Banned word check runs on both positive and negative prompt fields
- [ ] Partial-match flag correctly catches substrings when set; whole-word flag does not flag partial matches
- [ ] Case-insensitive matching works (`Test`, `TEST`, `test` all caught)
- [ ] Re-roll and edit flows also pass through the prompt guard
- [ ] Word list cache invalidates within 30 seconds of a `/banned add` or `/banned remove`

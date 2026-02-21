# LoRA Support Implementation Plan

**Goal:** Add up to 4 simultaneous LoRA selections to the generation flow, with per-LoRA strength, CivitAI trigger word auto-injection, and full persistence in the DB and re-roll/edit flows.

---

## Decisions

- Per-LoRA strength via a dedicated modal (4 text inputs) — avoids blowing Discord's 5-row ActionRow limit.
- Trigger words stored on `LoraParam.triggerWords` in-memory (draft) only; persisted to DB stripped (re-fetched from cache on Edit/Re-roll).
- CivitAI lookup: filename-normalised name search (`/api/v1/models?query=...&types=LORA`).
- `CIVITAI_API_KEY` is optional — anonymous requests supported with graceful 429 handling.
- Combined prompt (base + trigger words) written to the ComfyUI workflow at bind time, keeping `DraftParams.positivePrompt` clean for re-editing.
- Trigger words are shown in the LoRA embed AND pre-filled into the prompt at generation time.

---

## Step-by-Step Implementation

### 1. Types — `src/queue/types.ts`

Add `LoraParam` interface:
```ts
export interface LoraParam {
  name: string;        // filename e.g. "my_lora_v1.safetensors"
  strength: number;    // 0.1–2.0, default 1.0
  triggerWords: string[];  // fetched from CivitAI; not persisted to DB
}
```

Add to `DraftParams` and `JobParams`:
```ts
loras: (LoraParam | null)[];  // always length 4; null = empty slot
```

---

### 2. CivitAI client — new `src/civitai/client.ts`

```ts
export interface CivitaiLoraResult {
  name: string;
  triggerWords: string[];
}

export async function fetchLoraMetadata(
  filename: string,
  apiKey?: string
): Promise<CivitaiLoraResult | null>
```

- Strip extension, normalise filename (remove `_v1`, `_v2`, version suffixes).
- `GET https://civitai.com/api/v1/models?query={name}&types=LORA&limit=5`
- Pick best-matching result (exact or closest name match).
- Trigger words at `data[0].modelVersions[0].trainedWords: string[]`.
- On HTTP 429 or timeout: log warning, return `null`.
- Add `Authorization: Bearer <key>` header when `apiKey` is provided.

---

### 3. Trigger-word cache — new `src/civitai/triggerWords.ts`

```ts
export async function getTriggerWords(
  filename: string,
  apiKey?: string
): Promise<string[]>
```

- In-memory `Map<filename, { triggerWords: string[]; cachedAt: number }>` with 24-hour TTL.
- Cache hit → return immediately.
- Cache miss → call `fetchLoraMetadata()`, store result (even empty arrays to avoid re-querying).

---

### 4. Config — `src/config.ts`

Add optional env var to the Zod schema:
```ts
CIVITAI_API_KEY: z.string().optional(),
```
Export on the config object so it's accessible to the CivitAI client.

---

### 5. objectInfo — `src/comfy/objectInfo.ts`

Add:
```ts
export function getLoras(objectInfo: ObjectInfo): string[]
```
- Calls existing `getNodeInputList(objectInfo, "LoraLoader", "lora_name")`.
- Returns `string[]`.

Add `loras: string[]` to the `ComfyOptions` type.  
Update `fetchOptions()` to populate `loras` from `getLoras()`.

---

### 6. LoRA embed — new `src/bot/components/loraEmbed.ts`

Builds the LoRA configuration page. Layout (exactly 5 ActionRows):
- **Rows 1–4:** One `StringSelectMenuBuilder` per slot.
  - Label: `"LoRA Slot N"`
  - Options: `None` + up to 24 LoRA filenames (sanitised labels, full filename as value).
  - Pre-selects current draft value if set.
  - Custom IDs: `lora:select:0`, `lora:select:1`, `lora:select:2`, `lora:select:3`
- **Row 5:** Two buttons:
  - `← Back to Settings` (customId `lora:back`)
  - `⚙️ Set Strengths` (customId `lora:strength`) — disabled if no LoRAs active

The embed description lists each active LoRA with its trigger words (or "Fetching…" while pending, "None found" on CivitAI miss).

---

### 7. Strengths modal

Triggered by the `lora:strength` button. Opens a `ModalBuilder` (customId `lora:strength:submit`) with up to 4 `TextInputBuilder` rows — one per **active** LoRA slot only (skips empty slots). Each pre-fills with the current strength (`1.0` default).

Validation: Zod `z.coerce.number().min(0.1).max(2.0)` per field.  
On submit: update `draft.loras[i].strength` for each active slot.

---

### 8. Form embed — `src/bot/components/formEmbed.ts`

Replace the current 2-button row (Edit Prompts | Generate) with a 3-button row:
```
Edit Prompts  |  🎨 LoRAs (N)  |  Generate
```
- `N` = count of active LoRA slots (empty when 0, e.g. shows `🎨 LoRAs (2)`).
- customId: `lora:open`
- Keeps the 5-row total intact.
- Add a "Active LoRAs" section in the embed description when any are selected.

---

### 9. Interaction handler — `src/bot/events/interactionCreate.ts`

Add handlers for the following customId prefixes:

| customId | Action |
|---|---|
| `lora:open` | `interaction.update()` to the LoRA embed view |
| `lora:select:N` | `interaction.deferUpdate()` → `getTriggerWords()` → `mergeDraft()` updating `loras[N]` → `interaction.editReply()` with refreshed LoRA embed showing resolved trigger words |
| `lora:strength` | Open strengths modal |
| `lora:strength:submit` | Validate & apply strengths to draft → `interaction.update()` refreshed LoRA embed |
| `lora:back` | `interaction.update()` to the main form embed |

Also update the **re-roll** and **edit** post-generation flows to copy `loras` from the original `JobRow` (deserialised from DB JSON) into the new `DraftParams`.

---

### 10. Workflow binder — `src/comfy/workflowBinder.ts`

Add `injectLoras(workflow, loras: LoraParam[])` helper called at the top of `bind()` when active LoRAs exist.

Algorithm:
1. Filter `loras` to non-null entries (up to 4). Assign synthetic node IDs `"2001"`, `"2002"`, `"2003"`, `"2004"`.
2. Build each `LoraLoader` node:
   ```json
   {
     "class_type": "LoraLoader",
     "inputs": {
       "model": ["152", 0],      // or ["200N-1", 0] for chained nodes
       "clip":  ["152", 1],      // or ["200N-1", 1] for chained nodes
       "lora_name": "<filename>",
       "strength_model": 1.0,
       "strength_clip": 1.0
     }
   }
   ```
3. First node references checkpoint node `"152"` outputs 0 (MODEL) and 1 (CLIP). Each subsequent node chains from the previous.
4. Walk all other workflow nodes. Update any input currently referencing `["152", 0]` (MODEL) → `[lastLoraId, 0]`. Any input referencing `["152", 1]` (CLIP) → `[lastLoraId, 1]`.
5. Append the new nodes to the workflow object.

Also update the positive prompt written to node `"268"`:
```ts
const combined = [job.positivePrompt, ...job.loras.filter(Boolean).flatMap(l => l!.triggerWords)].join(" ").trim();
```

---

### 11. DB migration — new `migrations/005_add_loras.sql`

```sql
ALTER TABLE jobs ADD COLUMN loras TEXT NOT NULL DEFAULT '[]';
```

Apply: `sqlite3 data/imggen.db < migrations/005_add_loras.sql`

---

### 12. DB layer — `src/db/jobs.ts`

- `insertJob()`: serialise `params.loras` as `JSON.stringify(loras.map(l => l ? { name: l.name, strength: l.strength } : null))` — strip `triggerWords` before storing.
- Row mapping in `getJob()` / wherever rows are consumed: `JSON.parse(row.loras ?? '[]')`, default to `Array(4).fill(null)`.

---

## Verification Checklist

- [ ] Run migration: `sqlite3 data/imggen.db < migrations/005_add_loras.sql`
- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] `/gen` command shows "🎨 LoRAs (0)" button on the form embed
- [ ] Clicking LoRAs opens the LoRA embed with 4 slot selects
- [ ] Selecting a LoRA triggers a deferred update showing trigger words (or "None found")
- [ ] "Set Strengths" opens the modal pre-populated with current strengths
- [ ] Submitting the modal updates strengths and refreshes the embed
- [ ] Back button returns to the main form embed
- [ ] Clicking Generate with LoRAs active includes `LoraLoader` nodes in the ComfyUI workflow POST body
- [ ] Generated image embed shows active LoRAs
- [ ] Re-roll preserves LoRA selections from original job
- [ ] Edit (after generation) pre-populates LoRA slots from original job
- [ ] Setting `CIVITAI_API_KEY` in `.env` sends the Authorization header
- [ ] Unrecognised LoRA filename returns empty trigger words gracefully (no crash)
- [ ] HTTP 429 from CivitAI degrades gracefully (logs warning, no crash)

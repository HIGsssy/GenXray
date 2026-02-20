# ComfyGen Discord Bot — Architecture Document

**Date:** 2026-02-19  
**Status:** LOCKED for v1 implementation

---

## 1. Folder Structure & Module List

```
d:\imggen\
├── .ai\                          # Design docs (not deployed)
├── workflows\
│   └── multisampler\
│       └── base.json             # The one canonical workflow file
├── src\
│   ├── index.ts                  # Entry point: boot, register commands, start runner
│   ├── config.ts                 # Env validation (DISCORD_TOKEN, COMFY_URL, etc.)
│   ├── logger.ts                 # Pino-based logger; no-secrets filter
│   │
│   ├── comfy\
│   │   ├── client.ts             # HTTP wrapper for ComfyUI REST API
│   │   ├── objectInfo.ts         # object_info queries + option extraction
│   │   └── workflowBinder.ts     # Load, validate, and inject into base.json
│   │
│   ├── bot\
│   │   ├── commands\
│   │   │   └── gen.ts            # /gen slash command handler
│   │   ├── components\
│   │   │   ├── formEmbed.ts      # Build/update the ephemeral form embed
│   │   │   ├── dropdowns.ts      # Model / sampler / scheduler select menus
│   │   │   └── promptModal.ts    # Modal: positive, negative, steps, cfg
│   │   └── events\
│   │       ├── interactionCreate.ts  # Route interactions to handlers
│   │       └── ready.ts              # Bot ready; confirm allowed channels
│   │
│   ├── queue\
│   │   ├── jobQueue.ts           # In-memory queue + concurrency=1 runner loop
│   │   └── types.ts              # Job, JobStatus, QueueResult types
│   │
│   └── db\
│       ├── database.ts           # Better-sqlite3 init + migration runner
│       └── jobs.ts               # Insert/update/query job rows
│
├── migrations\
│   └── 001_initial.sql
├── package.json
├── tsconfig.json
└── .env.example
```

**Dependency list (package.json):**

| Package | Role |
|---|---|
| `discord.js` v14 | Bot framework |
| `better-sqlite3` | Synchronous SQLite (simpler in single-process bot) |
| `pino` + `pino-pretty` | Structured logging |
| `zod` | Runtime validation of workflow nodes and env config |
| `undici` | HTTP client for ComfyUI (already a peer of discord.js) |
| `tsx` / `ts-node` | Dev execution |
| `typescript` | Build |

---

## 2. Data Models & SQLite Schema

### 2.1 SQLite Schema (`migrations/001_initial.sql`)

```sql
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,          -- UUIDv4 generated at enqueue time
    discord_user_id   TEXT NOT NULL,
    discord_guild_id  TEXT NOT NULL,
    discord_channel_id TEXT NOT NULL,
    discord_message_id TEXT,               -- the "Generating…" message to edit
    status      TEXT NOT NULL DEFAULT 'queued',
      -- queued | running | completed | failed | cancelled
    model       TEXT NOT NULL,
    sampler     TEXT NOT NULL,
    scheduler   TEXT NOT NULL,
    steps       INTEGER NOT NULL,
    cfg         REAL NOT NULL,
    positive_prompt TEXT NOT NULL,
    negative_prompt TEXT NOT NULL DEFAULT '',
    comfy_prompt_id  TEXT,                 -- ComfyUI's prompt UUID, set at submit
    output_images    TEXT,                 -- JSON array of image URLs / filenames
    error_message    TEXT,
    created_at  INTEGER NOT NULL,          -- Unix ms
    started_at  INTEGER,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(discord_user_id);
```

### 2.2 In-Memory Job Record (runtime only)

The SQLite row is the source of truth. The queue holds only the `id` strings.

---

## 3. Interaction Flow

### 3.1 `/gen` slash command

1. Bot validates the invoking channel is in the allowed-channel list (env: `ALLOWED_CHANNEL_IDS`).  
2. If not allowed → ephemeral error, stop.  
3. `objectInfo.ts` provides cached option lists (model, sampler, scheduler).  
4. Bot replies with an **ephemeral** embed + three `StringSelectMenu` components (model, sampler, scheduler) and one `Button` (Edit Prompts & Settings).
5. A draft `JobParams` object is written to a per-user in-memory map keyed by `interaction.user.id` (no DB write yet).

### 3.2 Dropdown changes (model / sampler / scheduler)

1. `interactionCreate` routes `isStringSelectMenu()` by `customId` prefix.  
2. The selected value is merged into the user's draft `JobParams`.  
3. The ephemeral form embed is updated (edit original response) to reflect current selections.  
4. Sampler and scheduler dropdowns are **linked**: selecting a sampler resets scheduler to the first valid option for that sampler (no dependency enforcement in v1 — present all options for both independently).

### 3.3 "Edit Prompts & Settings" button → Modal

1. Bot shows a `ModalBuilder` with 5 inputs:
   - `positive_prompt` (paragraph, required)  
   - `negative_prompt` (paragraph, optional)  
   - `steps` (short text, default `"20"`, required)  
   - `cfg` (short text, default `"7"`, required)  
   - *(slot 5 reserved / unused in v1)*  
2. On modal submit, parse and validate `steps` (integer 1–150) and `cfg` (float 1–30) with Zod. If invalid, reply ephemeral with field-level errors and re-show the form.  
3. Merge into draft `JobParams`.  
4. Update the ephemeral form embed to reflect current values.

### 3.4 "Generate" button (final submit)

1. Validate draft `JobParams` is complete (all required fields present).  
2. Call `workflowBinder.validate()` — dry-run validation against `base.json` that all required node IDs and fields exist. If it fails, reply ephemeral error, do **not** enqueue.  
3. Persist job row to SQLite with `status = 'queued'`.  
4. Enqueue job ID into `jobQueue`.  
5. Reply ephemeral: "Queued! You are position **N** in the queue."  
6. (The ephemeral form embed is now stale read-only — no further edits.)

### 3.5 Queue Runner loop (`jobQueue.ts`)

Runs as a `setInterval` / async loop with `concurrency = 1`:

1. Dequeue next job ID; load full row from DB.  
2. Set `status = 'running'`, `started_at`.  
3. Call `workflowBinder.bind(jobRow)` → returns a fully-resolved workflow object.  
4. `POST /prompt` to ComfyUI with the bound workflow.  
5. Poll ComfyUI `GET /history/{prompt_id}` every 2 s, up to configurable timeout (default 300 s).  
6. On completion: download output images, upload to Discord channel, post embed with prompt details + images.  
7. Set `status = 'completed'`, `output_images`, `completed_at`.  
8. On any failure (timeout, ComfyUI error, network error): set `status = 'failed'`, `error_message`; post an error embed in-channel mentioning the user.  
9. Proceed to next job regardless of failure.

---

## 4. API Contracts (TypeScript Interfaces)

```typescript
// src/queue/types.ts

export interface JobParams {
  userId:          string;
  guildId:         string;
  channelId:       string;
  model:           string;
  sampler:         string;
  scheduler:       string;
  steps:           number;  // 1–150
  cfg:             number;  // 1.0–30.0
  positivePrompt:  string;
  negativePrompt:  string;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRow extends JobParams {
  id:               string;        // UUIDv4
  discordMessageId: string | null;
  status:           JobStatus;
  comfyPromptId:    string | null;
  outputImages:     string[] | null;
  errorMessage:     string | null;
  createdAt:        number;
  startedAt:        number | null;
  completedAt:      number | null;
}
```

```typescript
// src/comfy/objectInfo.ts

export interface ComfyOptions {
  models:     string[];   // ckpt_name values for loader node
  samplers:   string[];   // sampler_name values
  schedulers: string[];   // scheduler values
}

// Resolved once at startup and cached; refreshed on explicit reload command (future).
export async function fetchOptions(comfyBaseUrl: string): Promise<ComfyOptions>
```

```typescript
// src/comfy/workflowBinder.ts

export interface WorkflowBindResult {
  ok:       true;
  workflow: Record<string, unknown>;   // deep clone, ready for POST /prompt
}

export interface WorkflowBindError {
  ok:       false;
  reason:   string;   // human-readable; safe to surface to Discord user
}

export function validate(workflow: unknown): WorkflowBindResult | WorkflowBindError;
export function bind(job: JobRow, workflow: unknown): WorkflowBindResult | WorkflowBindError;
```

```typescript
// src/comfy/client.ts

export interface ComfyClient {
  submitPrompt(workflow: Record<string, unknown>): Promise<{ promptId: string }>;
  getHistory(promptId: string): Promise<ComfyHistoryEntry | null>;
  getImage(filename: string, subfolder: string, type: string): Promise<Buffer>;
  ping(): Promise<boolean>;   // fires GET /system_stats to check reachability
}

export interface ComfyHistoryEntry {
  status: { completed: boolean; status_str: string };
  outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}
```

---

## 5. Workflow Binding Rules (LOCKED, NON-NEGOTIABLE)

These map directly to `/workflows/multisampler/base.json`.

| Intent | Node ID | Field(s) |
|---|---|---|
| Checkpoint model | `"152"` | `inputs.ckpt_name` |
| Positive prompt | `"268"` | `inputs.text` |
| Negative prompt | `"4"` | `inputs.text` |
| Sampler + scheduler | `"239"` | `inputs.sampler_name`, `inputs.scheduler` |
| Sampler + scheduler | `"249"` | `inputs.sampler_name`, `inputs.scheduler` |
| Sampler + scheduler | `"52"` | `inputs.sampler_name`, `inputs.scheduler` |
| Sampler + scheduler | `"118"` | `inputs.sampler_name`, `inputs.scheduler` |
| Steps + CFG | `"239"` ONLY | `inputs.steps`, `inputs.cfg` |

**DO NOT** write `steps` or `cfg` to nodes `"249"`, `"52"`, or `"118"`.

### 5.1 Validation Contract

`validate()` must assert (in order):

1. Workflow is a plain object.  
2. Nodes `"152"`, `"268"`, `"4"`, `"239"`, `"249"`, `"52"`, `"118"` all exist as top-level keys.  
3. Each required node has an `inputs` object.  
4. Required fields within each `inputs` exist (strings or numbers — not null/undefined).  
5. Return `{ ok: false, reason: "<specific missing field>" }` on first failure.

---

## 6. Object Info Detection Strategy

### 6.1 Checkpoint Loader Detection

The deployed workflow uses **"Checkpoint Loader Simple Mikey"** (node `"152"`). To populate the model dropdown:

1. `GET /object_info` from ComfyUI (returns all registered node class types).
2. Check key `"CheckpointLoaderSimpleMikey"` first.  
3. If absent, fall back to `"CheckpointLoaderSimple"`.  
4. If neither exists, iterate all top-level keys and find the first whose name contains `"CheckpointLoader"`.  
5. Once the class is found, read `input.required.ckpt_name[0]` — ComfyUI returns the valid list there.  
6. If no class is found, bot logs a fatal error at startup and refuses to start (cannot build a useful model dropdown).

### 6.2 Sampler / Scheduler Detection

The deployed workflow uses **"KSampler (Efficient)"** nodes. To populate sampler/scheduler dropdowns:

1. Check key `"KSamplerAdvancedEfficient"` then `"KSamplerEfficient"` in `/object_info`.  
2. If absent, fall back to `"KSampler"` (standard ComfyUI).  
3. Read `input.required.sampler_name[0]` for sampler list and `input.required.scheduler[0]` for scheduler list.  
4. If the efficient sampler is absent but standard `KSampler` exists, log a warning (workflow may behave differently) and use standard lists.  
5. If no sampler class is found, bot logs a fatal error and refuses to start.

**Both lists are fetched once at startup and held in memory.** A future `!refresh` owner command can re-fetch.

---

## 7. Config & Environment

```
# .env.example
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=              # for guild-scoped command registration in dev
ALLOWED_CHANNEL_IDS=           # comma-separated channel snowflakes
COMFY_BASE_URL=http://127.0.0.1:8188
COMFY_TIMEOUT_MS=300000        # 5 min per job
QUEUE_CONCURRENCY=1            # must stay 1 for v1
DB_PATH=./data/comfygen.db
LOG_LEVEL=info
```

All values validated at startup with Zod. Missing required values → process exits with a clear error message.

---

## 8. Milestone Task List

### M1 — Project Scaffolding
**Acceptance criteria:**
- TypeScript project builds cleanly with zero errors.
- ESLint passes.
- `.env.example` present; config module validates and throws on missing vars.
- Logger initialized; secrets filter strips `DISCORD_TOKEN` from any accidental log line.

---

### M2 — ComfyUI Client + Object Info
**Acceptance criteria:**
- `ComfyClient.ping()` returns `true` against a live ComfyUI instance and `false` on connection refused.
- `fetchOptions()` correctly resolves the checkpoint loader class using the fallback chain (6.1) and sampler class using chain (6.2).
- Unit tests (with mocked HTTP) verify the fallback chain for both detection paths.
- If no class is found, an error is thrown with a clear message.

---

### M3 — Workflow Binder
**Acceptance criteria:**
- `validate(workflow)` returns `ok: false` with a specific reason for each of the required missing-node and missing-field scenarios.
- `bind(job, workflow)` correctly writes all fields per the locked mapping table (Section 5).
- Specifically verified: `steps` / `cfg` are written **only** to node `"239"` — not to `"249"`, `"52"`, or `"118"`.
- Unit tests cover at least: valid workflow, missing node, missing field, correct field isolation.

---

### M4 — SQLite Layer
**Acceptance criteria:**
- `database.ts` runs migration on first boot; re-running is idempotent.
- `jobs.ts` exposes typed insert/update/query functions.
- Querying jobs by status returns correctly typed `JobRow[]`.

---

### M5 — In-Memory Queue + Runner (no Discord yet)
**Acceptance criteria:**
- Queue processes one job at a time (concurrency=1).
- Jobs transition through `queued → running → completed/failed` with timestamps.
- On ComfyUI timeout, job is marked failed; runner advances to next job.
- On successful completion, `outputImages` is populated with filename array.
- Tested with a stub ComfyClient.

---

### M6 — Slash Command + Form Embed
**Acceptance criteria:**
- `/gen` registers and responds only in allowed channels.
- Ephemeral embed displays current draft values for model, sampler, scheduler, steps, cfg, prompts.
- Dropdown changes update the form embed with the new value.
- Draft state is isolated per user.

---

### M7 — Prompt Modal
**Acceptance criteria:**
- Modal shows current prompt/steps/cfg values as pre-filled defaults.
- Invalid `steps` (non-integer, out of range) returns an ephemeral field-level error without closing the form.
- Invalid `cfg` (non-float, out of range) same as above.
- Valid submit updates the form embed.

---

### M8 — Generate Button + Queue Integration
**Acceptance criteria:**
- "Generate" button validates complete `JobParams`, runs `workflowBinder.validate()`, inserts row, enqueues.
- User sees queue position (1-indexed count of jobs with `status = 'queued'` before this one, plus 1).
- Workflow validation failure produces an ephemeral error; no DB row is created.

---

### M9 — Output Posting
**Acceptance criteria:**
- On job completion, the bot posts an embed in the originating channel with the generated image(s) attached, the model name, sampler, scheduler, steps, cfg, and a truncated positive prompt (≤ 200 chars).
- User is `@mentioned` in the post.
- On job failure, an error embed is posted in-channel mentioning the user; the error message does not contain internal paths or secrets.

---

### M10 — Startup Validation & Hardening
**Acceptance criteria:**
- Bot refuses to start (exits with code 1) if: ComfyUI is unreachable, checkpoint class not found, sampler class not found, or `base.json` fails `validate()`.
- All startup checks log at `info` level; failures log at `fatal`.
- `SIGINT` / `SIGTERM` handlers flush the current job (if running) and close DB cleanly.

---

### M11 — Deployment Config
**Acceptance criteria:**
- `systemd` unit file present at `deploy/comfygen.service`.
- `pm2` ecosystem file present at `deploy/ecosystem.config.cjs`.
- `README.md` covers env setup, ComfyUI prerequisites, and how to register slash commands.

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ComfyUI node class names differ in user's install | High | Medium | Multi-step fallback chain (Section 6); fatal error with clear class-name guidance if all fallbacks fail |
| Workflow JSON drifts (node deleted/renamed) | Medium | High | `validate()` run at startup against loaded `base.json`; blocks startup |
| Discord ephemeral draft state lost on bot restart | Low | Low | Draft is pre-submit; user simply re-runs `/gen`. Not persisted by design. |
| ComfyUI queue backs up / times out | Medium | Medium | Per-job timeout (default 300 s); job marked `failed`; user notified; runner continues |
| User submits multiple jobs quickly | Low | Low | No per-user concurrency limit in v1 (intentional); queue is FIFO and fair by arrival order |
| `base.json` missing from deployment | Low | High | `workflowBinder` loads file at startup; throws fatal if not found |
| Discord select menu exceeds 25 options (many models) | Medium | Low | Truncate list to 25 with a log warning; future: pagination or search modal |
| Workflow output node structure changes | Low | Medium | `getHistory()` defensively checks for `outputs[nodeId].images`; logs warning if empty |

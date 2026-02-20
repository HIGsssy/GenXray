# ComfyGen Discord Bot

A Discord bot for image generation via a ComfyUI backend using a preconfigured workflow.

---

## Prerequisites

- **Node.js** 20+
- **ComfyUI** running and accessible (local or remote)
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- The **Checkpoint Loader Simple Mikey** custom node installed in ComfyUI (or a standard checkpoint loader)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example file and fill in all values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application (client) ID |
| `DISCORD_GUILD_ID` | Your development/production server ID |
| `ALLOWED_CHANNEL_IDS` | Comma-separated channel IDs where `/gen` is permitted |
| `COMFY_BASE_URL` | ComfyUI base URL (default: `http://127.0.0.1:8188`) |
| `COMFY_TIMEOUT_MS` | Per-job timeout in ms (default: `300000` — 5 min) |
| `DB_PATH` | SQLite database path (default: `./data/comfygen.db`) |
| `LOG_LEVEL` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |

### 3. Install the workflow

Export your ComfyUI workflow in **API format** (Enable Dev Mode → Save (API Format)) and save it to:

```
workflows/multisampler/base.json
```

The workflow **must** contain nodes with these exact IDs: `152`, `268`, `4`, `239`, `249`, `52`, `118`.  
The bot will refuse to start if any are missing. See `workflows/multisampler/base.json` for the required structure.

### 4. Register slash commands (dev — guild-scoped)

```bash
npm run deploy-commands
```

Commands appear instantly in your guild. Re-run after any command signature changes.

### 5. Run in development

```bash
npm run dev
```

### 6. Build for production

```bash
npm run build
npm start
```

---

## Deployment (Rocky Linux)

### systemd

```bash
sudo cp deploy/comfygen.service /etc/systemd/system/
sudo nano /etc/comfygen.env      # paste your env vars; chmod 600 this file
sudo systemctl daemon-reload
sudo systemctl enable --now comfygen
sudo journalctl -u comfygen -f
```

### pm2

```bash
npm run build
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

---

## Usage

1. `/gen` — opens an ephemeral form in an allowed channel.
2. Select **model**, **sampler**, **scheduler** from the dropdowns.
3. Click **Edit Prompts & Settings** to enter your prompts, steps, and CFG scale.
4. Click **Generate** — the bot confirms your queue position.
5. When complete, the bot posts the image(s) in the channel and mentions you.

---

## Architecture

See [`.ai/architecture.md`](.ai/architecture.md) for the full design document, module contracts, workflow binding rules, and milestone plan.

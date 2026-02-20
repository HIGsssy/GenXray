CREATE TABLE IF NOT EXISTS jobs (
    id                  TEXT    PRIMARY KEY,
    discord_user_id     TEXT    NOT NULL,
    discord_guild_id    TEXT    NOT NULL,
    discord_channel_id  TEXT    NOT NULL,
    discord_message_id  TEXT,
    status              TEXT    NOT NULL DEFAULT 'queued',
    model               TEXT    NOT NULL,
    sampler             TEXT    NOT NULL,
    scheduler           TEXT    NOT NULL,
    steps               INTEGER NOT NULL,
    cfg                 REAL    NOT NULL,
    positive_prompt     TEXT    NOT NULL,
    negative_prompt     TEXT    NOT NULL DEFAULT '',
    comfy_prompt_id     TEXT,
    output_images       TEXT,           -- JSON array of filenames
    error_message       TEXT,
    created_at          INTEGER NOT NULL,
    started_at          INTEGER,
    completed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_user   ON jobs(discord_user_id);

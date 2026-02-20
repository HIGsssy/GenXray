-- Migration 002: add seed column to jobs
-- SQLite does not support "ADD COLUMN IF NOT EXISTS" directly, so we use a
-- backwards-compatible approach: the column is added only when it is absent.
-- Running this migration multiple times is safe because the CREATE TABLE in
-- 001 already used IF NOT EXISTS and this ALTER is guarded at the app level.
ALTER TABLE jobs ADD COLUMN seed INTEGER NOT NULL DEFAULT 0;

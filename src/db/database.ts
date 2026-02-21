import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = resolve(config.db.path);
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  runMigrations(_db);
  logger.info({ dbPath }, "Database opened");
  return _db;
}

function runMigrations(db: Database.Database): void {
  const migrationDir = resolve(__dirname, "../../migrations");

  // 001 — initial schema (idempotent, uses IF NOT EXISTS)
  const sql001 = readFileSync(`${migrationDir}/001_initial.sql`, "utf-8");
  db.exec(sql001);

  // 002 — add seed column (guard against duplicate ALTER TABLE)
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "seed")) {
    const sql002 = readFileSync(`${migrationDir}/002_add_seed.sql`, "utf-8");
    db.exec(sql002);
    logger.info("Migration 002: seed column added");
  }

  // 003 — add size column
  const cols003 = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
  if (!cols003.some((c) => c.name === "size")) {
    const sql003 = readFileSync(`${migrationDir}/003_add_size.sql`, "utf-8");
    db.exec(sql003);
    logger.info("Migration 003: size column added");
  }

  logger.debug("Database migrations applied");
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info("Database closed");
  }
}

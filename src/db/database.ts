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
  const sql = readFileSync(`${migrationDir}/001_initial.sql`, "utf-8");
  db.exec(sql);
  logger.debug("Database migrations applied");
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info("Database closed");
  }
}
